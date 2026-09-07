import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

final class DraggableFileTile: NSView, NSDraggingSource {
    private let fileURL: URL
    private let title: String
    private let subtitle: String

    init(title: String, subtitle: String, fileURL: URL) {
        self.title = title
        self.subtitle = subtitle
        self.fileURL = fileURL
        super.init(frame: .zero)
        wantsLayer = true
        layer?.cornerRadius = 8
        layer?.borderWidth = 1
        layer?.borderColor = NSColor.controlAccentColor.withAlphaComponent(0.55).cgColor
        layer?.backgroundColor = NSColor.controlAccentColor.withAlphaComponent(0.12).cgColor

        let icon = NSImageView(image: NSWorkspace.shared.icon(forFile: fileURL.path))
        icon.translatesAutoresizingMaskIntoConstraints = false
        icon.imageScaling = .scaleProportionallyUpOrDown

        let titleLabel = NSTextField(labelWithString: title)
        titleLabel.font = .systemFont(ofSize: 15, weight: .semibold)
        titleLabel.textColor = .labelColor

        let subtitleLabel = NSTextField(labelWithString: subtitle)
        subtitleLabel.font = .systemFont(ofSize: 12)
        subtitleLabel.textColor = .secondaryLabelColor
        subtitleLabel.lineBreakMode = .byTruncatingMiddle

        let textStack = NSStackView(views: [titleLabel, subtitleLabel])
        textStack.translatesAutoresizingMaskIntoConstraints = false
        textStack.orientation = .vertical
        textStack.spacing = 3

        addSubview(icon)
        addSubview(textStack)

        NSLayoutConstraint.activate([
            heightAnchor.constraint(equalToConstant: 72),
            icon.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 14),
            icon.centerYAnchor.constraint(equalTo: centerYAnchor),
            icon.widthAnchor.constraint(equalToConstant: 38),
            icon.heightAnchor.constraint(equalToConstant: 38),
            textStack.leadingAnchor.constraint(equalTo: icon.trailingAnchor, constant: 12),
            textStack.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -14),
            textStack.centerYAnchor.constraint(equalTo: centerYAnchor)
        ])
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func mouseDown(with event: NSEvent) {
        let item = NSPasteboardItem()
        item.setString(fileURL.absoluteString, forType: .fileURL)
        let draggingItem = NSDraggingItem(pasteboardWriter: item)
        draggingItem.setDraggingFrame(bounds, contents: dragImage())
        beginDraggingSession(with: [draggingItem], event: event, source: self)
    }

    func draggingSession(_ session: NSDraggingSession, sourceOperationMaskFor context: NSDraggingContext) -> NSDragOperation {
        .copy
    }

    private func dragImage() -> NSImage {
        let image = NSImage(size: bounds.size)
        guard let rep = bitmapImageRepForCachingDisplay(in: bounds) else {
            return NSWorkspace.shared.icon(forFile: fileURL.path)
        }
        cacheDisplay(in: bounds, to: rep)
        image.addRepresentation(rep)
        return image
    }
}

final class PermissionGuideApp: NSObject, NSApplicationDelegate {
    private let agentAppPath: String
    private let appDir: String
    private var window: NSWindow?
    private var refreshTimer: Timer?
    private let statusLabel = NSTextField(labelWithString: "正在检测权限...")

    init(agentAppPath: String, appDir: String) {
        self.agentAppPath = agentAppPath
        self.appDir = appDir
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 640, height: 560),
            styleMask: [.titled, .closable, .miniaturizable],
            backing: .buffered,
            defer: false
        )
        window.title = "本机远程控制授权引导"
        window.center()
        window.contentView = makeContent()
        window.makeKeyAndOrderFront(nil)
        self.window = window
        NSApp.activate(ignoringOtherApps: true)
        refreshStatus()
        refreshTimer = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in
            self?.refreshStatus()
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        refreshTimer?.invalidate()
    }

    private func makeContent() -> NSView {
        let content = NSView()
        content.translatesAutoresizingMaskIntoConstraints = false

        let title = NSTextField(labelWithString: "完成两个 macOS 权限后即可看屏幕并控制鼠标键盘")
        title.font = .systemFont(ofSize: 20, weight: .bold)
        title.textColor = .labelColor
        title.lineBreakMode = .byWordWrapping
        title.maximumNumberOfLines = 2

        let intro = NSTextField(labelWithString: "在系统设置中为同一个 Local Remote Agent 打开两项权限。点击按钮可直达对应页面，也可以把下面的 App 卡片拖进列表。")
        intro.font = .systemFont(ofSize: 13)
        intro.textColor = .secondaryLabelColor
        intro.lineBreakMode = .byWordWrapping
        intro.maximumNumberOfLines = 3

        statusLabel.font = .monospacedSystemFont(ofSize: 12, weight: .regular)
        statusLabel.textColor = .secondaryLabelColor
        statusLabel.lineBreakMode = .byWordWrapping
        statusLabel.maximumNumberOfLines = 4

        let screenTile = DraggableFileTile(
            title: "拖到“屏幕录制”",
            subtitle: agentAppPath,
            fileURL: URL(fileURLWithPath: agentAppPath)
        )

        let accessTile = DraggableFileTile(
            title: "拖到“辅助功能”",
            subtitle: agentAppPath,
            fileURL: URL(fileURLWithPath: agentAppPath)
        )

        let openScreenButton = button("打开屏幕录制设置", action: #selector(openScreenRecordingSettings))
        let openAccessibilityButton = button("打开辅助功能设置", action: #selector(openAccessibilitySettings))
        let refreshButton = button("重新检测", action: #selector(refreshStatusAction))

        let stack = NSStackView(views: [
            title,
            intro,
            separator(),
            label("1. 屏幕录制"),
            screenTile,
            openScreenButton,
            label("2. 辅助功能"),
            accessTile,
            openAccessibilityButton,
            separator(),
            statusLabel,
            refreshButton
        ])
        stack.translatesAutoresizingMaskIntoConstraints = false
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 12

        for view in stack.arrangedSubviews {
            view.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        }

        content.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 24),
            stack.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -24),
            stack.topAnchor.constraint(equalTo: content.topAnchor, constant: 24),
            stack.bottomAnchor.constraint(lessThanOrEqualTo: content.bottomAnchor, constant: -24)
        ])
        return content
    }

    private func button(_ title: String, action: Selector) -> NSButton {
        let button = NSButton(title: title, target: self, action: action)
        button.bezelStyle = .rounded
        button.controlSize = .large
        return button
    }

    private func label(_ value: String) -> NSTextField {
        let label = NSTextField(labelWithString: value)
        label.font = .systemFont(ofSize: 15, weight: .semibold)
        label.textColor = .labelColor
        return label
    }

    private func separator() -> NSBox {
        let box = NSBox()
        box.boxType = .separator
        return box
    }

    @objc private func openScreenRecordingSettings() {
        openSettings("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")
    }

    @objc private func openAccessibilitySettings() {
        openSettings("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")
    }

    @objc private func refreshStatusAction() {
        refreshStatus()
    }

    private func openSettings(_ value: String) {
        guard let url = URL(string: value) else { return }
        NSWorkspace.shared.open(url)
    }

    private func refreshStatus() {
        guard let status = persistedAgentStatus() else {
            statusLabel.stringValue = "尚未收到常驻进程的权限记录。请先运行 ./start.sh 启动服务；此窗口会自动更新。"
            return
        }
        let accessibility = status["accessibilityTrusted"] as? Bool ?? false
        let screen = status["screenRecording"] as? Bool ?? false
        let timestamp = status["updatedAt"] as? String ?? ""
        let parser = ISO8601DateFormatter()
        parser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let updated = parser.date(from: timestamp)
        let fresh = updated.map { abs($0.timeIntervalSinceNow) < 15 } ?? false
        let time = updated.map { DateFormatter.localizedString(from: $0, dateStyle: .none, timeStyle: .medium) } ?? "未知"
        let freshness = fresh ? "自动更新中" : "记录已过期，请检查服务是否运行"
        statusLabel.stringValue = "最近记录 — 屏幕录制：\(screen ? "已就绪" : "待授权")    辅助功能：\(accessibility ? "已就绪" : "待授权")\n检测时间：\(time)（\(freshness)）\n授权后如画面仍未恢复，请运行 ./start.sh restart。"
    }

    private func persistedAgentStatus() -> [String: Any]? {
        let url = URL(fileURLWithPath: appDir).appendingPathComponent(".run/agent-permissions.json")
        do {
            let data = try Data(contentsOf: url)
            return try JSONSerialization.jsonObject(with: data) as? [String: Any]
        } catch {
            return nil
        }
    }
}

let agentAppPath = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "./.build/Local Remote Agent.app"
let appDir = CommandLine.arguments.count > 2 ? CommandLine.arguments[2] : FileManager.default.currentDirectoryPath
let app = NSApplication.shared
let delegate = PermissionGuideApp(agentAppPath: agentAppPath, appDir: appDir)
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
