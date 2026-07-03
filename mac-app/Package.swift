// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "video-publisher-app",
    platforms: [.macOS(.v13)],
    targets: [
        .executableTarget(
            name: "AIVideoPublisher",
            path: "Sources"
        )
    ]
)
