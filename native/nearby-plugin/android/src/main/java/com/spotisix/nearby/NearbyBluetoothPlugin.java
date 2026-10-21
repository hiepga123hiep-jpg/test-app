package com.spotisix.nearby;

import android.Manifest;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothGatt;
import android.bluetooth.BluetoothGattCallback;
import android.bluetooth.BluetoothGattCharacteristic;
import android.bluetooth.BluetoothGattServer;
import android.bluetooth.BluetoothGattServerCallback;
import android.bluetooth.BluetoothGattService;
import android.bluetooth.BluetoothManager;
import android.bluetooth.BluetoothProfile;
import android.bluetooth.le.AdvertiseCallback;
import android.bluetooth.le.AdvertiseData;
import android.bluetooth.le.AdvertiseSettings;
import android.bluetooth.le.BluetoothLeAdvertiser;
import android.bluetooth.le.BluetoothLeScanner;
import android.bluetooth.le.ScanCallback;
import android.bluetooth.le.ScanFilter;
import android.bluetooth.le.ScanResult;
import android.bluetooth.le.ScanSettings;
import android.os.Build;
import android.os.ParcelUuid;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

@CapacitorPlugin(
    name = "NearbyBluetooth",
    permissions = {
        @Permission(
            alias = "bluetooth",
            strings = {
                Manifest.permission.BLUETOOTH_SCAN,
                Manifest.permission.BLUETOOTH_ADVERTISE,
                Manifest.permission.BLUETOOTH_CONNECT
            }
        ),
        @Permission(alias = "location", strings = { Manifest.permission.ACCESS_FINE_LOCATION })
    }
)
public class NearbyBluetoothPlugin extends Plugin {
    private static final UUID SERVICE_UUID = UUID.fromString("96d8c873-b9a2-48a4-bfa8-7efc06d72c91");
    private static final UUID NAME_CHARACTERISTIC_UUID = UUID.fromString("e8f2c867-b21c-4e6b-844f-680e538a7ed3");

    private final Map<String, BluetoothGatt> connections = Collections.synchronizedMap(new HashMap<>());
    private final Map<String, String> peerIds = Collections.synchronizedMap(new HashMap<>());
    private final Map<String, Integer> peerRssi = Collections.synchronizedMap(new HashMap<>());
    private final Set<String> readingAddresses = Collections.synchronizedSet(new HashSet<>());
    private String displayName;
    private BluetoothAdapter adapter;
    private BluetoothGattServer gattServer;
    private BluetoothLeScanner scanner;
    private BluetoothLeAdvertiser advertiser;
    private PluginCall pendingPermissionCall;
    private PluginCall pendingStartCall;
    private boolean running;
    private boolean startRequested;

    @PluginMethod
    public void startDiscovery(PluginCall call) {
        if (running) {
            call.resolve();
            return;
        }
        if (pendingPermissionCall != null || startRequested) {
            call.reject("Đang khởi tạo tìm kiếm Bluetooth.");
            return;
        }
        String name = call.getString("displayName", "").trim();
        if (name.isEmpty()) {
            call.reject("Tên hiển thị không hợp lệ.");
            return;
        }
        displayName = name;
        if (hasRequiredPermissions()) {
            startAfterPermission(call);
        } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            pendingPermissionCall = call;
            requestPermissionForAlias("bluetooth", call, "permissionResult");
        } else {
            pendingPermissionCall = call;
            requestPermissionForAlias("location", call, "permissionResult");
        }
    }

    @PermissionCallback
    private void permissionResult(PluginCall call) {
        if (pendingPermissionCall != call) {
            return;
        }
        pendingPermissionCall = null;
        if (!hasRequiredPermissions()) {
            displayName = null;
            call.reject("Cần quyền Bluetooth để tìm người ở gần.");
            return;
        }
        startAfterPermission(call);
    }

    private boolean hasRequiredPermissions() {
        String alias = Build.VERSION.SDK_INT >= Build.VERSION_CODES.S ? "bluetooth" : "location";
        return getPermissionState(alias) == PermissionState.GRANTED;
    }

    private void startAfterPermission(PluginCall call) {
        startRequested = true;
        try {
            BluetoothManager manager = (BluetoothManager) getContext().getSystemService(android.content.Context.BLUETOOTH_SERVICE);
            adapter = manager == null ? null : manager.getAdapter();
            if (adapter == null || !adapter.isEnabled()) {
                startRequested = false;
                displayName = null;
                call.reject("Bật Bluetooth trên thiết bị rồi thử lại.");
                return;
            }
            scanner = adapter.getBluetoothLeScanner();
            advertiser = adapter.getBluetoothLeAdvertiser();
            if (scanner == null || advertiser == null) {
                startRequested = false;
                displayName = null;
                call.reject("Thiết bị không hỗ trợ quét và phát Bluetooth LE đồng thời.");
                return;
            }

            gattServer = manager.openGattServer(getContext(), gattServerCallback);
            if (gattServer == null) {
                startRequested = false;
                displayName = null;
                call.reject("Không thể khởi tạo máy chủ Bluetooth LE.");
                return;
            }
            BluetoothGattService service = new BluetoothGattService(SERVICE_UUID, BluetoothGattService.SERVICE_TYPE_PRIMARY);
            BluetoothGattCharacteristic nameCharacteristic = new BluetoothGattCharacteristic(
                NAME_CHARACTERISTIC_UUID,
                BluetoothGattCharacteristic.PROPERTY_READ,
                BluetoothGattCharacteristic.PERMISSION_READ
            );
            service.addCharacteristic(nameCharacteristic);
            pendingStartCall = call;
            if (!gattServer.addService(service)) {
                rejectStart("Không thể công bố thông tin Bluetooth.");
                stopNearby();
            }
        } catch (SecurityException error) {
            startRequested = false;
            displayName = null;
            call.reject("Không được cấp quyền Bluetooth cần thiết.");
        }
    }

    @PluginMethod
    public void stopDiscovery(PluginCall call) {
        String stopError = stopNearby();
        if (stopError == null) {
            call.resolve();
        } else {
            call.reject(stopError);
        }
    }

    private String stopNearby() {
        String stopError = null;
        if (scanner != null && scanCallback != null) {
            try {
                scanner.stopScan(scanCallback);
            } catch (SecurityException error) {
                stopError = "Không thể dừng quét Bluetooth do thiếu quyền.";
            }
        }
        if (advertiser != null && advertiseCallback != null) {
            try {
                advertiser.stopAdvertising(advertiseCallback);
            } catch (SecurityException error) {
                stopError = "Không thể dừng phát Bluetooth do thiếu quyền.";
            }
        }
        if (gattServer != null) {
            try {
                gattServer.close();
            } catch (SecurityException error) {
                stopError = "Không thể đóng dịch vụ Bluetooth do thiếu quyền.";
            }
        }
        synchronized (connections) {
            for (BluetoothGatt gatt : connections.values()) {
                try {
                    gatt.disconnect();
                    gatt.close();
                } catch (SecurityException error) {
                    stopError = "Không thể đóng kết nối Bluetooth do thiếu quyền.";
                }
            }
            connections.clear();
        }
        peerIds.clear();
        peerRssi.clear();
        readingAddresses.clear();
        scanner = null;
        advertiser = null;
        gattServer = null;
        running = false;
        startRequested = false;
        displayName = null;
        if (pendingPermissionCall != null) {
            pendingPermissionCall.reject("Đã hủy tìm người ở gần.");
            pendingPermissionCall = null;
        }
        if (pendingStartCall != null) {
            pendingStartCall.reject("Đã dừng tìm người ở gần.");
            pendingStartCall = null;
        }
        return stopError;
    }

    private final BluetoothGattServerCallback gattServerCallback = new BluetoothGattServerCallback() {
        @Override
        public void onServiceAdded(int status, BluetoothGattService service) {
            if (!startRequested || gattServer == null) {
                return;
            }
            if (status != BluetoothGatt.GATT_SUCCESS) {
                rejectStart("Không thể khởi tạo dịch vụ Bluetooth LE.");
                stopNearby();
                return;
            }
            AdvertiseSettings settings = new AdvertiseSettings.Builder()
                .setAdvertiseMode(AdvertiseSettings.ADVERTISE_MODE_LOW_LATENCY)
                .setConnectable(true)
                .setTimeout(0)
                .build();
            AdvertiseData data = new AdvertiseData.Builder()
                .addServiceUuid(new ParcelUuid(SERVICE_UUID))
                .setIncludeDeviceName(false)
                .build();
            try {
                advertiser.startAdvertising(settings, data, advertiseCallback);
                ScanFilter filter = new ScanFilter.Builder().setServiceUuid(new ParcelUuid(SERVICE_UUID)).build();
                ScanSettings scanSettings = new ScanSettings.Builder()
                    .setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY)
                    .build();
                scanner.startScan(Collections.singletonList(filter), scanSettings, scanCallback);
            } catch (SecurityException error) {
                rejectStart("Không được cấp quyền Bluetooth cần thiết.");
                stopNearby();
            }
        }

        @Override
        public void onCharacteristicReadRequest(
            BluetoothDevice device,
            int requestId,
            int offset,
            BluetoothGattCharacteristic characteristic
        ) {
            if (!NAME_CHARACTERISTIC_UUID.equals(characteristic.getUuid()) || displayName == null) {
                if (gattServer != null) {
                    gattServer.sendResponse(device, requestId, BluetoothGatt.GATT_REQUEST_NOT_SUPPORTED, offset, null);
                }
                return;
            }
            byte[] value = displayName.getBytes(StandardCharsets.UTF_8);
            if (offset > value.length) {
                if (gattServer != null) {
                    gattServer.sendResponse(device, requestId, BluetoothGatt.GATT_INVALID_OFFSET, offset, null);
                }
                return;
            }
            byte[] response = new byte[value.length - offset];
            System.arraycopy(value, offset, response, 0, response.length);
            if (gattServer != null) {
                gattServer.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, offset, response);
            }
        }
    };

    private final AdvertiseCallback advertiseCallback = new AdvertiseCallback() {
        @Override
        public void onStartSuccess(AdvertiseSettings settingsInEffect) {
            if (!startRequested) {
                return;
            }
            if (pendingStartCall != null) {
                pendingStartCall.resolve();
                pendingStartCall = null;
            }
            running = true;
            startRequested = false;
        }

        @Override
        public void onStartFailure(int errorCode) {
            rejectStart("Không thể phát tín hiệu Bluetooth LE (mã " + errorCode + ").");
            stopNearby();
        }
    };

    private final ScanCallback scanCallback = new ScanCallback() {
        @Override
        public void onScanResult(int callbackType, ScanResult result) {
            if (!startRequested && !running) {
                return;
            }
            BluetoothDevice device = result.getDevice();
            String address = device.getAddress();
            peerRssi.put(address, result.getRssi());
            if (connections.containsKey(address) || !readingAddresses.add(address)) {
                return;
            }
            BluetoothGatt gatt;
            try {
                gatt = device.connectGatt(getContext(), false, gattCallback);
            } catch (SecurityException error) {
                readingAddresses.remove(address);
                return;
            }
            if (gatt == null) {
                readingAddresses.remove(address);
                return;
            }
            connections.put(address, gatt);
        }
    };

    private final BluetoothGattCallback gattCallback = new BluetoothGattCallback() {
        @Override
        public void onConnectionStateChange(BluetoothGatt gatt, int status, int newState) {
            if (newState == BluetoothProfile.STATE_CONNECTED && status == BluetoothGatt.GATT_SUCCESS) {
                try {
                    gatt.discoverServices();
                } catch (SecurityException error) {
                    closeConnection(gatt);
                }
            } else if (newState == BluetoothProfile.STATE_DISCONNECTED) {
                closeConnection(gatt);
            }
        }

        @Override
        public void onServicesDiscovered(BluetoothGatt gatt, int status) {
            BluetoothGattService service = gatt.getService(SERVICE_UUID);
            BluetoothGattCharacteristic characteristic = service == null ? null : service.getCharacteristic(NAME_CHARACTERISTIC_UUID);
            if (status != BluetoothGatt.GATT_SUCCESS || characteristic == null) {
                closeConnection(gatt);
                return;
            }
            try {
                if (!gatt.readCharacteristic(characteristic)) closeConnection(gatt);
            } catch (SecurityException error) {
                closeConnection(gatt);
            }
        }

        @Override
        public void onCharacteristicRead(BluetoothGatt gatt, BluetoothGattCharacteristic characteristic, int status) {
            if (status == BluetoothGatt.GATT_SUCCESS && NAME_CHARACTERISTIC_UUID.equals(characteristic.getUuid())) {
                String name = new String(characteristic.getValue(), StandardCharsets.UTF_8).trim();
                if (!name.isEmpty()) {
                    String address = gatt.getDevice().getAddress();
                    String peerId;
                    synchronized (peerIds) {
                        peerId = peerIds.get(address);
                        if (peerId == null) {
                            peerId = UUID.randomUUID().toString();
                            peerIds.put(address, peerId);
                        }
                    }
                    JSObject peer = new JSObject();
                    peer.put("peerId", peerId);
                    peer.put("displayName", name);
                    peer.put("rssi", peerRssi.getOrDefault(address, -100));
                    notifyListeners("nearbyPeer", peer);
                }
            }
            closeConnection(gatt);
        }
    };

    private void closeConnection(BluetoothGatt gatt) {
        String address = gatt.getDevice().getAddress();
        connections.remove(address);
        readingAddresses.remove(address);
        gatt.close();
    }

    private void rejectStart(String message) {
        startRequested = false;
        if (pendingStartCall != null) {
            pendingStartCall.reject(message);
            pendingStartCall = null;
        }
    }

    @Override
    protected void handleOnDestroy() {
        stopNearby();
        super.handleOnDestroy();
    }
}
