// agent.swift — 常驻采集/控制守护进程
//
// 职责：
//   1. 用 ScreenCaptureKit 持续采集主屏幕，编码为 JPEG 帧输出到 stdout（仅画面变化时产帧）。
//   2. 从 stdin 读取换行分隔的 JSON 命令，注入鼠标/键盘事件（进程内执行，保证顺序与低延迟）。
//
// stdout 帧协议：[1 字节类型][4 字节大端长度][负载]
//   类型 'F' (0x46) = JPEG 帧；类型 'J' (0x4A) = JSON 事件（状态/错误）。
// stdin 命令协议：每行一个 JSON 对象，如 {"cmd":"move","x":100,"y":200}。

import AppKit
import ApplicationServices
import CoreGraphics
import CoreMedia
import Foundation
import ScreenCaptureKit
import UniformTypeIdentifiers
import VideoToolbox

// MARK: - stdout 输出通道（串行队列保证帧与 JSON 事件不交错）

final class Output {
    static let shared = Output()
    private let queue = DispatchQueue(label: "agent.output")
    private let handle = FileHandle.standardOutput

    private func send(type: UInt8, payload: Data) {
        queue.async {
            var packet = Data(capacity: payload.count + 5)
            packet.append(type)
            var length = UInt32(payload.count).bigEndian
            withUnsafeBytes(of: &length) { packet.append(contentsOf: $0) }
            packet.append(payload)
            do {
                try self.handle.write(contentsOf: packet)
            } catch {
                // stdout 已断开说明父进程退出，守护进程没有继续存在的意义
                exit(0)
            }
        }
    }

    func sendFrame(_ jpeg: Data) {
        send(type: 0x46, payload: jpeg)
    }

    func sendJSON(_ object: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: object) else { return }
        send(type: 0x4A, payload: data)
    }
}

// MARK: - 状态上报

func emitStatus() {
    let bounds = CGDisplayBounds(CGMainDisplayID())
    let manager = CaptureManager.shared
    Output.shared.sendJSON([
        "type": "status",
        "width": Int(bounds.width),
        "height": Int(bounds.height),
        "accessibilityTrusted": AXIsProcessTrusted(),
        "screenRecording": CGPreflightScreenCaptureAccess(),
        "capturing": manager.capturing,
        "fps": manager.fps,
        "captureError": manager.lastError as Any,
    ])
}

func emitError(_ message: String) {
    Output.shared.sendJSON(["type": "error", "message": message])
}

// MARK: - 鼠标事件注入

func mouseButton(_ value: String) -> CGMouseButton {
    switch value.lowercased() {
    case "right": return .right
    case "middle", "center": return .center
    default: return .left
    }
}

func mouseEventType(for button: CGMouseButton, down: Bool) -> CGEventType {
    switch (button, down) {
    case (.right, true): return .rightMouseDown
    case (.right, false): return .rightMouseUp
    case (.center, true): return .otherMouseDown
    case (.center, false): return .otherMouseUp
    case (_, true): return .leftMouseDown
    case (_, false): return .leftMouseUp
    }
}

func dragEventType(for button: CGMouseButton) -> CGEventType {
    switch button {
    case .right: return .rightMouseDragged
    case .center: return .otherMouseDragged
    default: return .leftMouseDragged
    }
}

func clampToDisplay(_ x: Double, _ y: Double) -> CGPoint {
    let bounds = CGDisplayBounds(CGMainDisplayID())
    return CGPoint(
        x: min(bounds.maxX - 1, max(bounds.minX, x)),
        y: min(bounds.maxY - 1, max(bounds.minY, y))
    )
}

func postMouseMove(_ point: CGPoint) {
    let event = CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left)
    event?.post(tap: .cghidEventTap)
}

// flags 支持修饰键+点击（如 ⌘+点击 / ⇧+点击 范围选择）
func postMouseButton(_ point: CGPoint, button: CGMouseButton, down: Bool, clickState: Int64 = 1, flags: CGEventFlags = []) {
    let event = CGEvent(mouseEventSource: nil, mouseType: mouseEventType(for: button, down: down), mouseCursorPosition: point, mouseButton: button)
    event?.setIntegerValueField(.mouseEventClickState, value: clickState)
    if !flags.isEmpty { event?.flags = flags }
    event?.post(tap: .cghidEventTap)
}

func postMouseDrag(_ point: CGPoint, button: CGMouseButton) {
    let event = CGEvent(mouseEventSource: nil, mouseType: dragEventType(for: button), mouseCursorPosition: point, mouseButton: button)
    event?.post(tap: .cghidEventTap)
}

// 多连击必须设置 clickState（1=单击，2=双击），否则 macOS 不识别为双击
func postClick(_ point: CGPoint, button: CGMouseButton, count: Int, flags: CGEventFlags = []) {
    postMouseMove(point)
    let clicks = max(1, min(3, count))
    for index in 1...clicks {
        postMouseButton(point, button: button, down: true, clickState: Int64(index), flags: flags)
        usleep(20_000)
        postMouseButton(point, button: button, down: false, clickState: Int64(index), flags: flags)
        if index < clicks { usleep(60_000) }
    }
}

func postWheel(dx: Double, dy: Double) {
    let event = CGEvent(
        scrollWheelEvent2Source: nil,
        units: .pixel,
        wheelCount: 2,
        wheel1: Int32(max(-32_000, min(32_000, -dy)).rounded()),
        wheel2: Int32(max(-32_000, min(32_000, -dx)).rounded()),
        wheel3: 0
    )
    event?.post(tap: .cghidEventTap)
}

// MARK: - 键盘事件注入

// 美式键盘布局虚拟键码表：命名键 + 字母数字符号，支持任意修饰键组合（如 cmd+c）
let keyCodes: [String: CGKeyCode] = [
    "enter": 36, "return": 36, "tab": 48, "space": 49, " ": 49,
    "escape": 53, "esc": 53, "backspace": 51, "delete": 51, "forwarddelete": 117,
    "arrowleft": 123, "left": 123, "arrowright": 124, "right": 124,
    "arrowdown": 125, "down": 125, "arrowup": 126, "up": 126,
    "home": 115, "end": 119, "pageup": 116, "pagedown": 121,
    "capslock": 57,
    "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97,
    "f7": 98, "f8": 100, "f9": 101, "f10": 109, "f11": 103, "f12": 111,
    "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7,
    "c": 8, "v": 9, "b": 11, "q": 12, "w": 13, "e": 14, "r": 15,
    "y": 16, "t": 17, "1": 18, "2": 19, "3": 20, "4": 21, "6": 22,
    "5": 23, "=": 24, "9": 25, "7": 26, "-": 27, "8": 28, "0": 29,
    "]": 30, "o": 31, "u": 32, "[": 33, "i": 34, "p": 35, "l": 37,
    "j": 38, "'": 39, "k": 40, ";": 41, "\\": 42, ",": 43, "/": 44,
    "n": 45, "m": 46, ".": 47, "`": 50,
]

func eventFlags(from modifiers: [String]) -> CGEventFlags {
    var flags = CGEventFlags()
    for modifier in modifiers {
        switch modifier.lowercased() {
        case "shift": flags.insert(.maskShift)
        case "control", "ctrl": flags.insert(.maskControl)
        case "option", "alt": flags.insert(.maskAlternate)
        case "command", "cmd", "meta": flags.insert(.maskCommand)
        default: continue
        }
    }
    return flags
}

func postKey(code: CGKeyCode, flags: CGEventFlags) {
    let down = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: true)
    down?.flags = flags
    down?.post(tap: .cghidEventTap)
    let up = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: false)
    up?.flags = flags
    up?.post(tap: .cghidEventTap)
}

// 以 Unicode 直接注入文本，不依赖键盘布局，支持中文等任意字符。
// 多字符文本按 1ms/字符 步进注入：零间隔连发大量事件时部分应用会丢字，
// 微小步进显著提高长文本可靠性；单字符实时输入不受影响
func postText(_ text: String) {
    let scalars = Array(text.unicodeScalars)
    for (index, scalar) in scalars.enumerated() {
        var chars = Array(String(scalar).utf16)
        let down = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true)
        down?.keyboardSetUnicodeString(stringLength: chars.count, unicodeString: &chars)
        down?.post(tap: .cghidEventTap)
        let up = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false)
        up?.keyboardSetUnicodeString(stringLength: chars.count, unicodeString: &chars)
        up?.post(tap: .cghidEventTap)
        if index < scalars.count - 1 { usleep(1_000) }
    }
}

// key 命令入口：优先键码表（可带修饰键组合），单字符退化为文本注入
func handleKeyCommand(key: String, modifiers: [String]) {
    let normalized = key.lowercased()
    let flags = eventFlags(from: modifiers)
    if let code = keyCodes[normalized] {
        postKey(code: code, flags: flags)
        return
    }
    if key.count == 1 && flags.isEmpty {
        postText(key)
        return
    }
    emitError("unsupported key: \(key)")
}

// MARK: - 屏幕采集

final class CaptureManager: NSObject, SCStreamOutput, SCStreamDelegate {
    static let shared = CaptureManager()

    var fps = 15
    var quality = 0.6
    var maxWidth = 1920

    private(set) var capturing = false
    private(set) var lastError: String?

    private var stream: SCStream?
    private var retryScheduled = false
    private let sampleQueue = DispatchQueue(label: "agent.capture")

    // 读取环境变量作为初始配置，运行期可用 config 命令覆盖
    func loadEnvConfig() {
        if let value = ProcessInfo.processInfo.environment["AGENT_FPS"], let parsed = Int(value) {
            fps = max(1, min(30, parsed))
        }
        if let value = ProcessInfo.processInfo.environment["AGENT_QUALITY"], let parsed = Double(value) {
            quality = max(0.2, min(0.95, parsed))
        }
        if let value = ProcessInfo.processInfo.environment["AGENT_MAX_WIDTH"], let parsed = Int(value) {
            maxWidth = max(640, min(3840, parsed))
        }
    }

    func restart() {
        Task { await self.start() }
    }

    func start() async {
        await stopStream()

        // 无录屏权限时不反复尝试建流，定时重试等待用户授权
        guard CGPreflightScreenCaptureAccess() else {
            capturing = false
            lastError = "screen recording permission not granted"
            emitStatus()
            scheduleRetry()
            return
        }

        do {
            let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
            let mainID = CGMainDisplayID()
            guard let display = content.displays.first(where: { $0.displayID == mainID }) ?? content.displays.first else {
                throw NSError(domain: "agent", code: 1, userInfo: [NSLocalizedDescriptionKey: "no display found"])
            }

            // 以显示器逻辑分辨率为基准限制采集宽度，平衡清晰度与带宽
            let pointWidth = max(1, display.width)
            let pointHeight = max(1, display.height)
            let targetWidth = min(maxWidth, pointWidth)
            let targetHeight = Int((Double(targetWidth) * Double(pointHeight) / Double(pointWidth)).rounded())

            let config = SCStreamConfiguration()
            config.width = targetWidth
            config.height = targetHeight
            config.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(fps))
            config.queueDepth = 3
            config.showsCursor = true
            config.pixelFormat = kCVPixelFormatType_32BGRA

            let filter = SCContentFilter(display: display, excludingWindows: [])
            let newStream = SCStream(filter: filter, configuration: config, delegate: self)
            try newStream.addStreamOutput(self, type: .screen, sampleHandlerQueue: sampleQueue)
            try await newStream.startCapture()

            stream = newStream
            capturing = true
            lastError = nil
            emitStatus()
        } catch {
            capturing = false
            lastError = String(describing: error)
            emitStatus()
            scheduleRetry()
        }
    }

    private func stopStream() async {
        guard let current = stream else { return }
        stream = nil
        capturing = false
        try? await current.stopCapture()
    }

    // 采集失败（无权限/显示器变化）后 5 秒重试，避免服务不可恢复
    private func scheduleRetry() {
        guard !retryScheduled else { return }
        retryScheduled = true
        DispatchQueue.main.asyncAfter(deadline: .now() + 5) { [weak self] in
            guard let self else { return }
            self.retryScheduled = false
            if !self.capturing { self.restart() }
        }
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        capturing = false
        lastError = String(describing: error)
        emitStatus()
        scheduleRetry()
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen, sampleBuffer.isValid else { return }

        // 只处理完整帧，跳过空闲/补白帧
        guard
            let attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
            let statusRaw = attachments.first?[.status] as? Int,
            SCFrameStatus(rawValue: statusRaw) == .complete,
            let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer)
        else { return }

        var cgImage: CGImage?
        VTCreateCGImageFromCVPixelBuffer(pixelBuffer, options: nil, imageOut: &cgImage)
        guard let image = cgImage else { return }

        let data = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(data, UTType.jpeg.identifier as CFString, 1, nil) else { return }
        let options = [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary
        CGImageDestinationAddImage(destination, image, options)
        guard CGImageDestinationFinalize(destination) else { return }

        Output.shared.sendFrame(data as Data)
    }
}

// MARK: - stdin 命令处理

// 输入事件在专用串行队列执行，保证鼠标/键盘事件严格按到达顺序注入
let inputQueue = DispatchQueue(label: "agent.input")

func handleCommand(_ object: [String: Any]) {
    guard let cmd = object["cmd"] as? String else {
        emitError("missing cmd field")
        return
    }

    func number(_ key: String) -> Double {
        (object[key] as? NSNumber)?.doubleValue ?? 0
    }
    func modifiers() -> [String] {
        (object["modifiers"] as? [Any])?.compactMap { $0 as? String } ?? []
    }
    let button = mouseButton(object["button"] as? String ?? "left")

    switch cmd {
    case "move":
        let point = clampToDisplay(number("x"), number("y"))
        inputQueue.async { postMouseMove(point) }
    case "drag":
        let point = clampToDisplay(number("x"), number("y"))
        inputQueue.async { postMouseDrag(point, button: button) }
    case "down":
        let point = clampToDisplay(number("x"), number("y"))
        // count 用于 clickState：连续快速按下时让远程端识别为真双击/三击
        let downState = Int64(max(1, min(3, Int(number("count")) == 0 ? 1 : Int(number("count")))))
        let flags = eventFlags(from: modifiers())
        inputQueue.async {
            postMouseMove(point)
            postMouseButton(point, button: button, down: true, clickState: downState, flags: flags)
        }
    case "up":
        let point = clampToDisplay(number("x"), number("y"))
        let upState = Int64(max(1, min(3, Int(number("count")) == 0 ? 1 : Int(number("count")))))
        let flags = eventFlags(from: modifiers())
        inputQueue.async { postMouseButton(point, button: button, down: false, clickState: upState, flags: flags) }
    case "click":
        let point = clampToDisplay(number("x"), number("y"))
        let count = Int(number("count"))
        let flags = eventFlags(from: modifiers())
        inputQueue.async { postClick(point, button: button, count: count == 0 ? 1 : count, flags: flags) }
    case "wheel":
        let dx = number("dx")
        let dy = number("dy")
        inputQueue.async { postWheel(dx: dx, dy: dy) }
    case "key":
        let key = object["key"] as? String ?? ""
        let mods = modifiers()
        // repeat：同一按键连发次数（差分同步的批量退格/方向键合并为单条命令）
        let rawRepeat = Int(number("repeat"))
        let repeats = max(1, min(2000, rawRepeat == 0 ? 1 : rawRepeat))
        guard !key.isEmpty else {
            emitError("key command missing key")
            return
        }
        inputQueue.async {
            for index in 0..<repeats {
                handleKeyCommand(key: key, modifiers: mods)
                if index < repeats - 1 { usleep(1_000) }
            }
        }
    case "text":
        let text = object["text"] as? String ?? ""
        guard !text.isEmpty else { return }
        inputQueue.async { postText(text) }
    case "status":
        emitStatus()
    case "config":
        let manager = CaptureManager.shared
        if let value = (object["fps"] as? NSNumber)?.intValue { manager.fps = max(1, min(30, value)) }
        if let value = (object["quality"] as? NSNumber)?.doubleValue { manager.quality = max(0.2, min(0.95, value)) }
        if let value = (object["maxWidth"] as? NSNumber)?.intValue { manager.maxWidth = max(640, min(3840, value)) }
        manager.restart()
    case "promptScreen":
        // 触发系统录屏授权弹窗；授权后靠定时重试自动恢复采集
        CGRequestScreenCaptureAccess()
        emitStatus()
    case "promptAccessibility":
        let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
        _ = AXIsProcessTrustedWithOptions(options)
        emitStatus()
    default:
        emitError("unknown cmd: \(cmd)")
    }
}

func startStdinLoop() {
    DispatchQueue.global(qos: .userInteractive).async {
        let handle = FileHandle.standardInput
        var buffer = Data()
        while true {
            let chunk = handle.availableData
            // stdin 关闭说明父进程退出，跟随退出避免孤儿进程
            if chunk.isEmpty { exit(0) }
            buffer.append(chunk)
            while let newlineRange = buffer.range(of: Data([0x0A])) {
                let line = buffer.subdata(in: buffer.startIndex..<newlineRange.lowerBound)
                buffer.removeSubrange(buffer.startIndex..<newlineRange.upperBound)
                guard !line.isEmpty else { continue }
                do {
                    guard let object = try JSONSerialization.jsonObject(with: line) as? [String: Any] else {
                        emitError("command is not a JSON object")
                        continue
                    }
                    handleCommand(object)
                } catch {
                    emitError("invalid command JSON: \(error.localizedDescription)")
                }
            }
        }
    }
}

// MARK: - 入口

signal(SIGPIPE, SIG_IGN)
CaptureManager.shared.loadEnvConfig()
startStdinLoop()
emitStatus()
CaptureManager.shared.restart()
RunLoop.main.run()
