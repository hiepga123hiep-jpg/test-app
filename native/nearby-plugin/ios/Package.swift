// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "SpotisixNearbyBluetoothPlugin",
    platforms: [.iOS(.v15)],
    products: [
        .library(name: "SpotisixNearbyBluetoothPlugin", targets: ["SpotisixNearbyBluetoothPlugin"])
    ],
    dependencies: [
        .package(name: "Capacitor", path: "../../node_modules/@capacitor/ios")
    ],
    targets: [
        .target(
            name: "SpotisixNearbyBluetoothPlugin",
            dependencies: [.product(name: "Capacitor", package: "Capacitor")],
            path: "Sources/NearbyBluetoothPlugin"
        )
    ]
)
