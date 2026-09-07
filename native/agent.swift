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
    private let lock = NSLock()
    private var pendingFrame: Data?
    private var frameScheduled = false
    private var frameGeneration: UInt64 = 0
    private var pendingEvents = 0

    // Keep only the newest waiting frame when Node stops reading. A blocked pipe
    // must not retain an unbounded queue of full-resolution JPEGs.
    func sendFrame(_ jpeg: Data) {
        lock.lock()
        pendingFrame = jpeg
        let schedule = !frameScheduled
        let generation = frameGeneration
        frameScheduled = true
        lock.unlock()
        if schedule { queue.async { self.drainFrame(generation: generation) } }
    }

    func discardPendingFrame() {
        lock.lock()
        pendingFrame = nil
        frameGeneration &+= 1
        frameScheduled = false
        lock.unlock()
    }

    private func drainFrame(generation: UInt64) {
        lock.lock()
        guard frameGeneration == generation else { lock.unlock(); return }
        let frame = pendingFrame
        pendingFrame = nil
        lock.unlock()
        if let frame { write(type: 0x46, payload: frame) }
        lock.lock()
        guard frameGeneration == generation else { lock.unlock(); return }
        let more = pendingFrame != nil
        frameScheduled = more
        lock.unlock()
        // Re-enqueue instead of looping, so status events cannot starve.
        if more { queue.async { self.drainFrame(generation: generation) } }
    }

    private func write(type: UInt8, payload: Data) {
        var packet = Data(capacity: payload.count + 5)
        packet.append(type)
        var length = UInt32(payload.count).bigEndian
        withUnsafeBytes(of: &length) { packet.append(contentsOf: $0) }
        packet.append(payload)
        do {
            try handle.write(contentsOf: packet)
        } catch {
            shutdownWorker()
        }
    }

    func sendJSON(_ object: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: object) else { return }
        lock.lock()
        guard pendingEvents < 128 else { lock.unlock(); return }
        pendingEvents += 1
        lock.unlock()
        queue.async {
            self.write(type: 0x4A, payload: data)
            self.lock.lock()
            self.pendingEvents -= 1
            self.lock.unlock()
        }
    }
}

// MARK: - 状态上报

func emitStatus() {
    Task { @MainActor in CaptureManager.shared.emitStatus() }
}

func emitError(_ message: String) {
    Output.shared.sendJSON(["type": "error", "message": message])
}

// The browser sends coordinates relative to the captured display, in points.
// Core Graphics expects global desktop coordinates, including negative origins.
func displayPoint(x: Double, y: Double, bounds: CGRect) -> CGPoint {
    CGPoint(
        x: bounds.minX + min(max(0, bounds.width - 1), max(0, x)),
        y: bounds.minY + min(max(0, bounds.height - 1), max(0, y))
    )
}

final class InputGeometry {
    static let shared = InputGeometry()
    private let lock = NSLock()
    private var bounds = CGDisplayBounds(CGMainDisplayID())

    func update(_ bounds: CGRect) {
        lock.lock()
        self.bounds = bounds
        lock.unlock()
    }

    func point(x: Double, y: Double) -> CGPoint {
        lock.lock()
        let current = bounds
        lock.unlock()
        return displayPoint(x: x, y: y, bounds: current)
    }
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

func postMouseMove(_ point: CGPoint) {
    let event = CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left)
    event?.post(tap: .cghidEventTap)
}

// flags 支持修饰键+点击（如 ⌘+点击 / ⇧+点击 范围选择）
func postMouseButton(_ point: CGPoint, button: CGMouseButton, down: Bool, clickState: Int64 = 1, flags: CGEventFlags = []) {
    let event = CGEvent(mouseEventSource: nil, mouseType: mouseEventType(for: button, down: down), mouseCursorPosition: point, mouseButton: button)
    event?.setIntegerValueField(.mouseEventClickState, value: clickState)
    event?.flags = flags
    event?.post(tap: .cghidEventTap)
}

func postMouseDrag(_ point: CGPoint, button: CGMouseButton, flags: CGEventFlags = []) {
    let event = CGEvent(mouseEventSource: nil, mouseType: dragEventType(for: button), mouseCursorPosition: point, mouseButton: button)
    event?.flags = flags
    event?.post(tap: .cghidEventTap)
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
func postText(_ text: String, cancelled: () -> Bool = { false }) {
    let scalars = Array(text.unicodeScalars)
    for (index, scalar) in scalars.enumerated() {
        if cancelled() { break }
        var chars = Array(String(scalar).utf16)
        let down = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true)
        down?.flags = []
        down?.keyboardSetUnicodeString(stringLength: chars.count, unicodeString: &chars)
        down?.post(tap: .cghidEventTap)
        let up = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false)
        up?.flags = []
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

// Read by the sample queue; updated by the main actor. Old stream callbacks must
// never emit frames or change the state of a replacement stream.
final class CaptureSamples {
    private let lock = NSLock()
    private var activeStream: ObjectIdentifier?
    private var quality = 0.6
    private var unavailable = true
    private var pendingJPEG: Data?
    private var deliveryScheduled = false

    func activate(_ stream: AnyObject?, quality: Double) {
        lock.lock()
        activeStream = stream.map(ObjectIdentifier.init)
        self.quality = quality
        unavailable = true
        pendingJPEG = nil
        deliveryScheduled = false
        lock.unlock()
    }

    func configuration(for stream: AnyObject) -> Double? {
        lock.lock()
        defer { lock.unlock() }
        return activeStream == ObjectIdentifier(stream) ? quality : nil
    }

    func isAvailable(for stream: AnyObject) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return activeStream == ObjectIdentifier(stream) && !unavailable
    }

    func changeAvailability(for stream: AnyObject, unavailable: Bool) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        guard activeStream == ObjectIdentifier(stream), self.unavailable != unavailable else { return false }
        self.unavailable = unavailable
        if unavailable { pendingJPEG = nil }
        return true
    }
    // Bound the sample-queue to main-actor handoff too; a busy main actor must
    // not accumulate a Task retaining every encoded frame.
    func offerFrame(_ jpeg: Data, for stream: AnyObject) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        guard activeStream == ObjectIdentifier(stream), !unavailable else { return false }
        pendingJPEG = jpeg
        guard !deliveryScheduled else { return false }
        deliveryScheduled = true
        return true
    }

    func takeFrame(for stream: AnyObject) -> Data? {
        lock.lock()
        defer { lock.unlock() }
        guard activeStream == ObjectIdentifier(stream) else { return nil }
        defer { pendingJPEG = nil; deliveryScheduled = false }
        return pendingJPEG
    }
}

@MainActor
final class CaptureManager: NSObject, SCStreamOutput, SCStreamDelegate {
    static let shared = CaptureManager()

    var fps = 15
    var quality = 0.6
    var maxWidth = 1920
    private(set) var capturing = false
    private(set) var lastError: String?
    private var displayID = CGMainDisplayID()
    private var bounds = CGDisplayBounds(CGMainDisplayID())
    private var frameWidth = 0
    private var frameHeight = 0
    private var stream: SCStream?
    private var retryTask: Task<Void, Never>?
    private var workerRunning = false
    private var revision: UInt64 = 0
    private let sampleQueue = DispatchQueue(label: "agent.capture")
    nonisolated private let samples = CaptureSamples()

    func emitStatus() {
        Output.shared.sendJSON([
            "type": "status",
            "width": Int(bounds.width), "height": Int(bounds.height),
            "displayID": displayID, "originX": Int(bounds.minX), "originY": Int(bounds.minY),
            "frameWidth": frameWidth, "frameHeight": frameHeight,
            "accessibilityTrusted": AXIsProcessTrusted(),
            "screenRecording": CGPreflightScreenCaptureAccess(),
            "capturing": capturing, "fps": fps, "quality": quality, "maxWidth": maxWidth,
            "captureError": lastError.map { $0 as Any } ?? NSNull(),
        ])
    }

    func loadEnvConfig() {
        let env = ProcessInfo.processInfo.environment
        if let value = env["AGENT_FPS"], let parsed = Double(value), parsed.isFinite {
            fps = boundedInteger(parsed, default: 15, range: 1...30)
        }
        if let value = env["AGENT_QUALITY"], let parsed = Double(value), parsed.isFinite {
            quality = max(0.2, min(0.95, parsed))
        }
        if let value = env["AGENT_MAX_WIDTH"], let parsed = Double(value), parsed.isFinite {
            maxWidth = boundedInteger(parsed, default: 1920, range: 640...3840)
        }
    }

    // Coalesce config bursts into one worker. Actor isolation alone would not
    // serialize start/stop operations across their suspension points.
    func restart() {
        revision &+= 1
        retryTask?.cancel()
        retryTask = nil
        guard !workerRunning else { return }
        workerRunning = true
        Task { @MainActor in
            while true {
                let requested = self.revision
                await self.replaceStream(revision: requested)
                if requested == self.revision { break }
            }
            self.workerRunning = false
        }
    }

    private func replaceStream(revision requested: UInt64) async {
        await stopStream()
        guard requested == revision else { return }
        guard CGPreflightScreenCaptureAccess() else {
            lastError = "screen recording permission not granted"
            emitStatus()
            scheduleRetry()
            return
        }
        do {
            let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
            guard requested == revision else { return }
            let mainID = CGMainDisplayID()
            guard let display = content.displays.first(where: { $0.displayID == mainID }) ?? content.displays.first else {
                throw NSError(domain: "agent", code: 1, userInfo: [NSLocalizedDescriptionKey: "no display found"])
            }
            displayID = display.displayID
            bounds = CGDisplayBounds(displayID)
            InputGeometry.shared.update(bounds)
            let pointWidth = max(1, Int(bounds.width))
            let pointHeight = max(1, Int(bounds.height))
            frameWidth = min(maxWidth, pointWidth)
            frameHeight = max(1, Int((Double(frameWidth) * Double(pointHeight) / Double(pointWidth)).rounded()))
            let config = SCStreamConfiguration()
            config.width = frameWidth
            config.height = frameHeight
            config.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(fps))
            config.queueDepth = 3
            config.showsCursor = true
            config.pixelFormat = kCVPixelFormatType_32BGRA

            let filter = SCContentFilter(display: display, excludingWindows: [])
            let newStream = SCStream(filter: filter, configuration: config, delegate: self)
            try newStream.addStreamOutput(self, type: .screen, sampleHandlerQueue: sampleQueue)
            stream = newStream
            samples.activate(newStream, quality: quality)
            // Metadata precedes the first frame, including after display changes.
            emitStatus()
            try await newStream.startCapture()
            guard requested == revision, stream === newStream else { return }
            emitStatus()
        } catch {
            guard requested == revision else { return }
            await stopStream()
            lastError = error.localizedDescription
            emitStatus()
            scheduleRetry()
        }
    }

    private func stopStream() async {
        let previous = stream
        stream = nil
        samples.activate(nil, quality: quality)
        Output.shared.discardPendingFrame()
        capturing = false
        InputController.shared.setCaptureAvailable(false)
        emitStatus()
        if let previous { try? await previous.stopCapture() }
    }

    private func scheduleRetry() {
        guard retryTask == nil else { return }
        retryTask = Task { @MainActor [weak self] in
            do { try await Task.sleep(nanoseconds: 5_000_000_000) } catch { return }
            guard let self else { return }
            self.retryTask = nil
            if !self.capturing { self.restart() }
        }
    }

    func displayConfigurationChanged() {
        restart()
    }

    nonisolated func stream(_ stopped: SCStream, didStopWithError error: Error) {
        Task { @MainActor in
            guard self.stream === stopped else { return }
            self.stream = nil
            self.samples.activate(nil, quality: self.quality)
            Output.shared.discardPendingFrame()
            self.capturing = false
            self.lastError = error.localizedDescription
            InputController.shared.setCaptureAvailable(false)
            self.emitStatus()
            self.scheduleRetry()
        }
    }

    nonisolated func stream(_ source: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen, sampleBuffer.isValid,
              let quality = samples.configuration(for: source),
              let attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
              let statusRaw = attachments.first?[.status] as? Int,
              let status = SCFrameStatus(rawValue: statusRaw) else { return }
        // Idle means an unchanged desktop, not a stalled capture. Suspended or
        // blank capture must disable control until complete frames resume.
        if status == .blank || status == .suspended || status == .stopped || status == .complete {
            let unavailable = status != .complete
            if samples.changeAvailability(for: source, unavailable: unavailable), unavailable {
                Task { @MainActor in
                    guard self.stream === source, !self.samples.isAvailable(for: source) else { return }
                    self.capturing = false
                    self.lastError = "display capture is temporarily unavailable"
                    Output.shared.discardPendingFrame()
                    InputController.shared.setCaptureAvailable(false)
                    self.emitStatus()
                }
            }
        }
        guard status == .complete, let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        var cgImage: CGImage?
        VTCreateCGImageFromCVPixelBuffer(pixelBuffer, options: nil, imageOut: &cgImage)
        guard let image = cgImage else { return }
        let data = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(data, UTType.jpeg.identifier as CFString, 1, nil) else { return }
        let options = [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary
        CGImageDestinationAddImage(destination, image, options)
        guard CGImageDestinationFinalize(destination) else { return }
        guard samples.offerFrame(data as Data, for: source) else { return }
        Task { @MainActor in
            guard let jpeg = self.samples.takeFrame(for: source),
                  self.stream === source, self.samples.isAvailable(for: source) else { return }
            if !self.capturing {
                self.capturing = true
                self.lastError = nil
                InputController.shared.setCaptureAvailable(true)
                // A stationary desktop might emit only this one frame. Publish
                // ready status before it, so Node does not discard the first frame.
                self.emitStatus()
            }
            Output.shared.sendFrame(jpeg)
        }
    }
}

// MARK: - stdin 命令处理

// All posted input stays ordered. Releasing control advances the generation
// immediately, so pending text/repeat jobs are cancelled before any release.
final class InputController {
    static let shared = InputController()
    private let queue = DispatchQueue(label: "agent.input")
    private let lock = NSLock()
    private var generation: UInt64 = 0
    private var pointerGeneration: UInt64 = 0
    private var pending = 0
    private var captureAvailable = false
    private var pressed: [UInt32: CGPoint] = [:]
    private let isTrusted: () -> Bool

    init(isTrusted: @escaping () -> Bool = AXIsProcessTrusted) {
        self.isTrusted = isTrusted
    }

    func enqueue(pointer: Bool = false, _ action: @escaping (InputController, () -> Bool) -> Void) {
        lock.lock()
        guard pending < 128 else {
            lock.unlock()
            releaseInputs()
            emitError("input queue full; pending input cancelled")
            return
        }
        guard captureAvailable else { lock.unlock(); return }
        let expected = generation
        let expectedPointer = pointerGeneration
        pending += 1
        queue.async {
            let cancelled = { () -> Bool in
                self.lock.lock()
                defer { self.lock.unlock() }
                return self.generation != expected || (pointer && self.pointerGeneration != expectedPointer)
            }
            if !cancelled() && self.isTrusted() { action(self, cancelled) }
            self.lock.lock()
            self.pending -= 1
            self.lock.unlock()
        }
        lock.unlock()
    }

    func down(_ point: CGPoint, button: CGMouseButton, count: Int64, flags: CGEventFlags) {
        pressed[button.rawValue] = point
        postMouseMove(point)
        postMouseButton(point, button: button, down: true, clickState: count, flags: flags)
    }

    func drag(_ point: CGPoint, button: CGMouseButton, flags: CGEventFlags) {
        guard pressed[button.rawValue] != nil else { return }
        pressed[button.rawValue] = point
        postMouseDrag(point, button: button, flags: flags)
    }

    func up(_ point: CGPoint, button: CGMouseButton, count: Int64, flags: CGEventFlags) {
        pressed.removeValue(forKey: button.rawValue)
        postMouseButton(point, button: button, down: false, clickState: count, flags: flags)
    }

    func setCaptureAvailable(_ available: Bool) {
        lock.lock()
        captureAvailable = available
        lock.unlock()
        if !available { releaseInputs() }
    }

    func releasePointers(completion: (() -> Void)? = nil) {
        release(cancelText: false, completion: completion)
    }

    func releaseInputs(completion: (() -> Void)? = nil) {
        release(cancelText: true, completion: completion)
    }

    private func release(cancelText: Bool, completion: (() -> Void)?) {
        lock.lock()
        pointerGeneration &+= 1
        if cancelText { generation &+= 1 }
        queue.async {
            for (raw, point) in self.pressed {
                if let button = CGMouseButton(rawValue: raw) {
                    postMouseButton(point, button: button, down: false)
                }
            }
            self.pressed.removeAll()
            completion?()
        }
        lock.unlock()
    }
}

func finiteNumber(_ value: Any?) -> Double? {
    guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(), number.doubleValue.isFinite else { return nil }
    return number.doubleValue
}

func boundedInteger(_ value: Double?, default fallback: Int, range: ClosedRange<Int>) -> Int {
    guard let value, value.isFinite else { return fallback }
    return Int(min(Double(range.upperBound), max(Double(range.lowerBound), value)))
}

func handleCommand(_ object: [String: Any]) {
    guard let cmd = object["cmd"] as? String else { emitError("missing cmd field"); return }
    let button = mouseButton(object["button"] as? String ?? "left")
    let modifiers = object["modifiers"] as? [String] ?? []
    let flags = eventFlags(from: modifiers)
    let count = boundedInteger(finiteNumber(object["count"]), default: 1, range: 1...3)
    let controller = InputController.shared

    switch cmd {
    case "move", "drag", "down", "up", "click":
        guard let x = finiteNumber(object["x"]), let y = finiteNumber(object["y"]) else {
            emitError("pointer command requires finite x and y")
            return
        }
        let point = InputGeometry.shared.point(x: x, y: y)
        controller.enqueue(pointer: true) { input, cancelled in
            switch cmd {
            case "move": postMouseMove(point)
            case "drag": input.drag(point, button: button, flags: flags)
            case "down": input.down(point, button: button, count: Int64(count), flags: flags)
            case "up": input.up(point, button: button, count: Int64(count), flags: flags)
            default:
                for index in 1...count {
                    if cancelled() { break }
                    input.down(point, button: button, count: Int64(index), flags: flags)
                    usleep(20_000)
                    input.up(point, button: button, count: Int64(index), flags: flags)
                    if index < count { usleep(60_000) }
                }
            }
        }
    case "wheel":
        guard let dx = finiteNumber(object["dx"]), let dy = finiteNumber(object["dy"]) else {
            emitError("wheel command requires finite dx and dy")
            return
        }
        controller.enqueue(pointer: true) { _, _ in postWheel(dx: dx, dy: dy) }
    case "key":
        guard let key = object["key"] as? String, !key.isEmpty, key.utf8.count <= 64 else {
            emitError("key command missing or invalid key")
            return
        }
        let repeats = boundedInteger(finiteNumber(object["repeat"]), default: 1, range: 1...2000)
        controller.enqueue { _, cancelled in
            for index in 0..<repeats {
                if cancelled() { break }
                handleKeyCommand(key: key, modifiers: modifiers)
                if index < repeats - 1 { usleep(1_000) }
            }
        }
    case "text":
        guard let value = object["text"] as? String, !value.isEmpty else { return }
        guard value.utf8.count <= 32_768 else { emitError("text command is too large"); return }
        controller.enqueue { _, cancelled in postText(value, cancelled: cancelled) }
    case "releasePointers":
        controller.releasePointers()
    case "releaseInputs":
        controller.releaseInputs()
    case "status":
        emitStatus()
    case "config":
        Task { @MainActor in
            let manager = CaptureManager.shared
            manager.fps = boundedInteger(finiteNumber(object["fps"]), default: manager.fps, range: 1...30)
            if let value = finiteNumber(object["quality"]) { manager.quality = max(0.2, min(0.95, value)) }
            manager.maxWidth = boundedInteger(finiteNumber(object["maxWidth"]), default: manager.maxWidth, range: 640...3840)
            manager.restart()
        }
    case "promptScreen":
        Task { @MainActor in
            CGRequestScreenCaptureAccess()
            CaptureManager.shared.restart()
            CaptureManager.shared.emitStatus()
        }
    case "promptAccessibility":
        Task { @MainActor in
            let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
            _ = AXIsProcessTrustedWithOptions(options)
            CaptureManager.shared.emitStatus()
        }
    default:
        emitError("unknown command")
    }
}

let shutdownLock = NSLock()
var workerShuttingDown = false
func shutdownWorker() {
    shutdownLock.lock()
    guard !workerShuttingDown else { shutdownLock.unlock(); return }
    workerShuttingDown = true
    shutdownLock.unlock()
    InputController.shared.releaseInputs { exit(0) }
}

func startStdinLoop() {
    DispatchQueue.global(qos: .userInteractive).async {
        let handle = FileHandle.standardInput
        var buffer = Data()
        var droppingOversizeLine = false
        let maxLineBytes = 65_536
        while true {
            let chunk = handle.availableData
            if chunk.isEmpty { shutdownWorker(); return }
            buffer.append(chunk)
            while let newline = buffer.firstIndex(of: 0x0A) {
                let line = buffer.prefix(upTo: newline)
                if !droppingOversizeLine {
                    if line.count > maxLineBytes {
                        emitError("command line is too large")
                    } else if !line.isEmpty {
                        do {
                            if let object = try JSONSerialization.jsonObject(with: line) as? [String: Any] {
                                handleCommand(object)
                            } else { emitError("command is not a JSON object") }
                        } catch { emitError("invalid command JSON") }
                    }
                }
                buffer.removeSubrange(buffer.startIndex...newline)
                droppingOversizeLine = false
            }
            if buffer.count > maxLineBytes {
                if !droppingOversizeLine { emitError("command line is too large") }
                droppingOversizeLine = true
                buffer.removeAll(keepingCapacity: false)
            }
        }
    }
}

// Pure regression checks: no permission prompts, capture, or input injection.
func runSelfTests() {
    func check(_ condition: @autoclosure () -> Bool, _ message: String) {
        guard condition() else { fputs("FAIL: \(message)\n", stderr); exit(1) }
    }
    let bounds = CGRect(x: -1920, y: 200, width: 1920, height: 1080)
    check(displayPoint(x: 100, y: 50, bounds: bounds) == CGPoint(x: -1820, y: 250), "display-local coordinate mapping")
    check(displayPoint(x: -100, y: 5000, bounds: bounds) == CGPoint(x: -1920, y: 1279), "display bounds clamping")
    check(boundedInteger(1e100, default: 1, range: 1...2000) == 2000, "large number conversion")
    check(boundedInteger(-1e100, default: 1, range: 1...2000) == 1, "negative number conversion")
    check(boundedInteger(.nan, default: 15, range: 1...30) == 15, "NaN fallback")
    check(finiteNumber(true) == nil && finiteNumber("2") == nil && finiteNumber(Double.infinity) == nil, "invalid numeric types")
    check(finiteNumber(2.5) == 2.5, "finite number accepted")
    check(eventFlags(from: ["cmd", "shift"]) == [.maskCommand, .maskShift], "modifier aliases")
    let samples = CaptureSamples()
    let firstStream = NSObject()
    let replacement = NSObject()
    samples.activate(firstStream, quality: 0.6)
    check(!samples.isAvailable(for: firstStream), "capture waits for complete frame")
    check(samples.changeAvailability(for: firstStream, unavailable: false), "complete frame enables capture")
    check(samples.offerFrame(Data([1]), for: firstStream), "first frame schedules delivery")
    check(!samples.offerFrame(Data([2]), for: firstStream), "subsequent frame coalesces")
    check(samples.takeFrame(for: firstStream) == Data([2]), "newest frame wins under backpressure")
    samples.activate(replacement, quality: 0.8)
    check(samples.configuration(for: firstStream) == nil, "old stream configuration ignored")
    check(!samples.changeAvailability(for: firstStream, unavailable: false), "old stream status ignored")
    check(!samples.offerFrame(Data([3]), for: firstStream), "old stream frame ignored")
    check(samples.configuration(for: replacement) == 0.8, "replacement stream configuration")

    let input = InputController(isTrusted: { true })
    let started = DispatchSemaphore(value: 0)
    let proceed = DispatchSemaphore(value: 0)
    let completed = DispatchSemaphore(value: 0)
    let resumed = DispatchSemaphore(value: 0)
    input.setCaptureAvailable(true)
    input.enqueue { _, cancelled in
        started.signal()
        _ = proceed.wait(timeout: .now() + 2)
        check(cancelled(), "running input cancellation")
    }
    check(started.wait(timeout: .now() + 2) == .success, "input worker started")
    input.enqueue { _, _ in check(false, "stale queued input must not run") }
    input.releaseInputs { completed.signal() }
    input.enqueue { _, _ in resumed.signal() }
    proceed.signal()
    check(completed.wait(timeout: .now() + 2) == .success, "release completes after cancellation")
    check(resumed.wait(timeout: .now() + 2) == .success, "new input resumes after release")
    // A drag owner may disconnect while another client's accepted text is still
    // running. Cancel queued pointer-down without truncating that text.
    input.enqueue { _, cancelled in
        started.signal()
        _ = proceed.wait(timeout: .now() + 2)
        check(!cancelled(), "pointer release must preserve another client's running text")
    }
    check(started.wait(timeout: .now() + 2) == .success, "text running before pointer release")
    input.enqueue(pointer: true) { _, _ in check(false, "cancelled pointer-down must never run after text") }
    input.enqueue { _, _ in resumed.signal() }
    input.releasePointers { completed.signal() }
    proceed.signal()
    check(completed.wait(timeout: .now() + 2) == .success, "pointer release completes")
    check(resumed.wait(timeout: .now() + 2) == .success, "pointer release preserves queued text")
    input.enqueue(pointer: true) { _, _ in resumed.signal() }
    check(resumed.wait(timeout: .now() + 2) == .success, "new pointer input resumes after release")

    input.setCaptureAvailable(false)
    input.enqueue { _, _ in check(false, "input forbidden while capture is unavailable") }
    input.releaseInputs { completed.signal() }
    check(completed.wait(timeout: .now() + 2) == .success, "unavailable input remains suppressed")
    print("Native self-tests passed (numeric, coordinates, modifiers, stream identity, frame backpressure, input cancellation and capture gating; no capture or input injection).")
}

// MARK: - 入口

func runServiceLauncher() -> Never {
    let arguments = Array(CommandLine.arguments.dropFirst(2))
    guard let executable = arguments.first else {
        fputs("Usage: local-remote-agent --service <executable> [arguments...]\n", stderr)
        exit(2)
    }

    let child = Process()
    child.executableURL = URL(fileURLWithPath: executable)
    child.arguments = Array(arguments.dropFirst())
    child.currentDirectoryURL = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)

    // launchd 只向顶层服务进程发信号。让 app bundle 保持为 TCC 的
    // responsible process，同时把停止信号转发给 Node 完成优雅退出。
    signal(SIGTERM, SIG_IGN)
    signal(SIGINT, SIG_IGN)
    let signalQueue = DispatchQueue(label: "agent.service.signals")
    let terminationSource = DispatchSource.makeSignalSource(signal: SIGTERM, queue: signalQueue)
    let interruptSource = DispatchSource.makeSignalSource(signal: SIGINT, queue: signalQueue)
    terminationSource.setEventHandler { child.terminate() }
    interruptSource.setEventHandler { child.interrupt() }
    terminationSource.resume()
    interruptSource.resume()

    do {
        try child.run()
        child.waitUntilExit()
        terminationSource.cancel()
        interruptSource.cancel()
        exit(child.terminationStatus)
    } catch {
        fputs("Failed to launch service child: \(error.localizedDescription)\n", stderr)
        exit(1)
    }
}

if CommandLine.arguments.dropFirst().first == "--service" {
    runServiceLauncher()
}

if CommandLine.arguments.dropFirst().first == "--self-test" {
    runSelfTests()
    exit(0)
}

signal(SIGPIPE, SIG_IGN)
signal(SIGTERM, SIG_IGN)
signal(SIGINT, SIG_IGN)
let terminationSource = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
let interruptSource = DispatchSource.makeSignalSource(signal: SIGINT, queue: .main)
terminationSource.setEventHandler { shutdownWorker() }
interruptSource.setEventHandler { shutdownWorker() }
terminationSource.resume()
interruptSource.resume()
Task { @MainActor in
    CaptureManager.shared.loadEnvConfig()
    startStdinLoop()
    CaptureManager.shared.emitStatus()
    CaptureManager.shared.restart()
}

// 必须由 launchd 管理的实际常驻进程发起请求。由 Terminal 或授权引导
// 临时拉起同一个文件时，macOS 可能按不同的 responsible process 归因。
if !AXIsProcessTrusted() {
    let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
    _ = AXIsProcessTrustedWithOptions(options)
}
// Monitor hot-plug, rotation, and resolution changes; the new stream and input
// geometry must always describe the same display.
CGDisplayRegisterReconfigurationCallback({ _, flags, _ in
    if !flags.contains(.beginConfigurationFlag) {
        Task { @MainActor in CaptureManager.shared.displayConfigurationChanged() }
    }
}, nil)
RunLoop.main.run()
