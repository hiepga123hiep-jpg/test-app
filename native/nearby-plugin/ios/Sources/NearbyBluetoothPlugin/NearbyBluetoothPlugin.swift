import Capacitor
import CoreBluetooth
import Foundation

@objc(NearbyBluetoothPlugin)
public class NearbyBluetoothPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "NearbyBluetoothPlugin"
    public let jsName = "NearbyBluetooth"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "startDiscovery", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stopDiscovery", returnType: CAPPluginReturnPromise)
    ]

    private let serviceUUID = CBUUID(string: "96D8C873-B9A2-48A4-BFA8-7EFC06D72C91")
    private let nameCharacteristicUUID = CBUUID(string: "E8F2C867-B21C-4E6B-844F-680E538A7ED3")
    private var centralManager: CBCentralManager?
    private var peripheralManager: CBPeripheralManager?
    private var displayName = ""
    private var pendingStartCall: CAPPluginCall?
    private var serviceAdded = false
    private var connectingPeripherals = Set<UUID>()
    private var connectedPeripherals: [UUID: CBPeripheral] = [:]
    private var peerRSSI: [UUID: NSNumber] = [:]

    @objc func startDiscovery(_ call: CAPPluginCall) {
        let name = (call.getString("displayName") ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else {
            call.reject("Tên hiển thị không hợp lệ.")
            return
        }
        guard centralManager == nil, peripheralManager == nil else {
            call.reject("Phiên tìm người ở gần đang hoạt động.")
            return
        }

        displayName = String(name.prefix(40))
        pendingStartCall = call
        centralManager = CBCentralManager(delegate: self, queue: .main)
        peripheralManager = CBPeripheralManager(delegate: self, queue: .main)
    }

    @objc func stopDiscovery(_ call: CAPPluginCall) {
        stopNearby()
        call.resolve()
    }

    private func configureIfReady() {
        guard
            let centralManager,
            let peripheralManager,
            centralManager.state == .poweredOn,
            peripheralManager.state == .poweredOn,
            !serviceAdded
        else {
            return
        }

        let characteristic = CBMutableCharacteristic(
            type: nameCharacteristicUUID,
            properties: [.read],
            value: Data(displayName.utf8),
            permissions: [.readable]
        )
        let service = CBMutableService(type: serviceUUID, primary: true)
        service.characteristics = [characteristic]
        serviceAdded = true
        peripheralManager.add(service)
    }

    private func startScanningAndAdvertising() {
        guard let centralManager, let peripheralManager else { return }
        centralManager.scanForPeripherals(
            withServices: [serviceUUID],
            options: [CBCentralManagerScanOptionAllowDuplicatesKey: true]
        )
        peripheralManager.startAdvertising([CBAdvertisementDataServiceUUIDsKey: [serviceUUID]])
    }

    private func stopNearby() {
        centralManager?.stopScan()
        peripheralManager?.stopAdvertising()
        peripheralManager?.removeAllServices()
        for peripheral in connectedPeripherals.values {
            centralManager?.cancelPeripheralConnection(peripheral)
        }
        if let pendingStartCall {
            pendingStartCall.reject("Đã dừng tìm người ở gần.")
            self.pendingStartCall = nil
        }
        centralManager = nil
        peripheralManager = nil
        serviceAdded = false
        connectingPeripherals.removeAll()
        connectedPeripherals.removeAll()
        peerRSSI.removeAll()
        displayName = ""
    }

    private func failStart(_ message: String) {
        pendingStartCall?.reject(message)
        pendingStartCall = nil
        stopNearby()
    }
}

extension NearbyBluetoothPlugin: CBCentralManagerDelegate {
    public func centralManagerDidUpdateState(_ central: CBCentralManager) {
        guard central.state == .poweredOn else {
            if central.state == .unauthorized || central.state == .poweredOff || central.state == .unsupported {
                failStart("Bật Bluetooth và cấp quyền cho SpotiSix để tìm người ở gần.")
            }
            return
        }
        configureIfReady()
    }

    public func centralManager(
        _ central: CBCentralManager,
        didDiscover peripheral: CBPeripheral,
        advertisementData: [String: Any],
        rssi RSSI: NSNumber
    ) {
        guard connectingPeripherals.insert(peripheral.identifier).inserted else { return }
        peerRSSI[peripheral.identifier] = RSSI
        peripheral.delegate = self
        central.connect(peripheral)
    }

    public func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
        connectedPeripherals[peripheral.identifier] = peripheral
        peripheral.discoverServices([serviceUUID])
    }

    public func centralManager(_ central: CBCentralManager, didFailToConnect peripheral: CBPeripheral, error: Error?) {
        connectingPeripherals.remove(peripheral.identifier)
    }

    public func centralManager(_ central: CBCentralManager, didDisconnectPeripheral peripheral: CBPeripheral, error: Error?) {
        connectingPeripherals.remove(peripheral.identifier)
        connectedPeripherals.removeValue(forKey: peripheral.identifier)
    }
}

extension NearbyBluetoothPlugin: CBPeripheralManagerDelegate {
    public func peripheralManagerDidUpdateState(_ peripheral: CBPeripheralManager) {
        guard peripheral.state == .poweredOn else {
            if peripheral.state == .unauthorized || peripheral.state == .poweredOff || peripheral.state == .unsupported {
                failStart("Bật Bluetooth và cấp quyền cho SpotiSix để tìm người ở gần.")
            }
            return
        }
        configureIfReady()
    }

    public func peripheralManager(_ peripheral: CBPeripheralManager, didAdd service: CBService, error: Error?) {
        guard error == nil else {
            failStart("Không thể khởi tạo dịch vụ Bluetooth LE.")
            return
        }
        startScanningAndAdvertising()
    }

    public func peripheralManagerDidStartAdvertising(_ peripheral: CBPeripheralManager, error: Error?) {
        guard error == nil else {
            failStart("Không thể phát tín hiệu Bluetooth LE.")
            return
        }
        pendingStartCall?.resolve()
        pendingStartCall = nil
    }
}

extension NearbyBluetoothPlugin: CBPeripheralDelegate {
    public func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
        guard error == nil,
              let service = peripheral.services?.first(where: { $0.uuid == serviceUUID })
        else {
            centralManager?.cancelPeripheralConnection(peripheral)
            return
        }
        peripheral.discoverCharacteristics([nameCharacteristicUUID], for: service)
    }

    public func peripheral(
        _ peripheral: CBPeripheral,
        didDiscoverCharacteristicsFor service: CBService,
        error: Error?
    ) {
        guard error == nil,
              let characteristic = service.characteristics?.first(where: { $0.uuid == nameCharacteristicUUID })
        else {
            centralManager?.cancelPeripheralConnection(peripheral)
            return
        }
        peripheral.readValue(for: characteristic)
    }

    public func peripheral(
        _ peripheral: CBPeripheral,
        didUpdateValueFor characteristic: CBCharacteristic,
        error: Error?
    ) {
        defer { centralManager?.cancelPeripheralConnection(peripheral) }
        guard error == nil,
              characteristic.uuid == nameCharacteristicUUID,
              let value = characteristic.value,
              let name = String(data: value, encoding: .utf8)?
                .trimmingCharacters(in: .whitespacesAndNewlines),
              !name.isEmpty
        else {
            return
        }
        notifyListeners("nearbyPeer", data: [
            "peerId": peripheral.identifier.uuidString,
            "displayName": name,
            "rssi": peerRSSI[peripheral.identifier]?.intValue ?? 0
        ])
    }
}
