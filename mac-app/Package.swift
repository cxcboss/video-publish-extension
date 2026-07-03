// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "AI视频发布助手",
    platforms: [.macOS(.v13)],
    targets: [
        .executableTarget(
            name: "AIVideoPublisher",
            path: "Sources"
        )
    ]
)
