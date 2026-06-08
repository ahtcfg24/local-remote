import ApplicationServices
import CoreGraphics
import Foundation

struct CommandError: Error, CustomStringConvertible {
    let description: String
}

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(1)
}

func jsonEscape(_ value: String) -> String {
    var escaped = ""
    for scalar in value.unicodeScalars {
        switch scalar.value {
        case 34: escaped += "\\\""
        case 92: escaped += "\\\\"
        case 8: escaped += "\\b"
        case 12: escaped += "\\f"
        case 10: escaped += "\\n"
        case 13: escaped += "\\r"
        case 9: escaped += "\\t"
        case 0...31:
            escaped += String(format: "\\u%04x", scalar.value)
        default:
            escaped.unicodeScalars.append(scalar)
        }
    }
    return escaped
}

func arg(_ index: Int) throws -> String {
    guard CommandLine.arguments.count > index else {
        throw CommandError(description: "missing argument \(index)")
    }
    return CommandLine.arguments[index]
}

func doubleArg(_ index: Int) throws -> Double {
    guard let value = Double(try arg(index)) else {
        throw CommandError(description: "invalid number at argument \(index)")
    }
    return value
}

func pointFromArgs(_ start: Int) throws -> CGPoint {
    CGPoint(x: try doubleArg(start), y: try doubleArg(start + 1))
}

func mouseButton(_ value: String) -> CGMouseButton {
    switch value.lowercased() {
    case "right": return .right
    case "middle", "center": return .center
    default: return .left
    }
}

func mouseTypes(for button: CGMouseButton, down: Bool) -> CGEventType {
    switch (button, down) {
    case (.right, true): return .rightMouseDown
    case (.right, false): return .rightMouseUp
    case (.center, true): return .otherMouseDown
    case (.center, false): return .otherMouseUp
    case (_, true): return .leftMouseDown
    case (_, false): return .leftMouseUp
    }
}

func dragType(for button: CGMouseButton) -> CGEventType {
    switch button {
    case .right: return .rightMouseDragged
    case .center: return .otherMouseDragged
    default: return .leftMouseDragged
    }
}

func postMouseMove(_ point: CGPoint) {
    CGWarpMouseCursorPosition(point)
    let event = CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left)
    event?.post(tap: .cghidEventTap)
}

func postMouseButton(_ point: CGPoint, button: CGMouseButton, down: Bool) {
    postMouseMove(point)
    let event = CGEvent(mouseEventSource: nil, mouseType: mouseTypes(for: button, down: down), mouseCursorPosition: point, mouseButton: button)
    event?.post(tap: .cghidEventTap)
}

func postMouseDrag(_ point: CGPoint, button: CGMouseButton) {
    CGWarpMouseCursorPosition(point)
    let event = CGEvent(mouseEventSource: nil, mouseType: dragType(for: button), mouseCursorPosition: point, mouseButton: button)
    event?.post(tap: .cghidEventTap)
}

func postClick(_ point: CGPoint, button: CGMouseButton) {
    postMouseButton(point, button: button, down: true)
    usleep(40_000)
    postMouseButton(point, button: button, down: false)
}

func postWheel(dx: Double, dy: Double) {
    let event = CGEvent(
        scrollWheelEvent2Source: nil,
        units: .pixel,
        wheelCount: 2,
        wheel1: Int32(-dy.rounded()),
        wheel2: Int32(-dx.rounded()),
        wheel3: 0
    )
    event?.post(tap: .cghidEventTap)
}

let keyCodes: [String: CGKeyCode] = [
    "enter": 36,
    "return": 36,
    "tab": 48,
    "space": 49,
    "escape": 53,
    "esc": 53,
    "backspace": 51,
    "delete": 51,
    "forwarddelete": 117,
    "arrowleft": 123,
    "left": 123,
    "arrowright": 124,
    "right": 124,
    "arrowdown": 125,
    "down": 125,
    "arrowup": 126,
    "up": 126,
    "home": 115,
    "end": 119,
    "pageup": 116,
    "pagedown": 121
]

func flags(from value: String?) -> CGEventFlags {
    guard let value else { return [] }
    var result = CGEventFlags()
    for rawPart in value.split(separator: ",") {
        switch rawPart.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
        case "shift": result.insert(.maskShift)
        case "control", "ctrl": result.insert(.maskControl)
        case "option", "alt": result.insert(.maskAlternate)
        case "command", "cmd", "meta": result.insert(.maskCommand)
        default: continue
        }
    }
    return result
}

func postKey(code: CGKeyCode, flags: CGEventFlags = []) {
    let down = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: true)
    down?.flags = flags
    down?.post(tap: .cghidEventTap)
    let up = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: false)
    up?.flags = flags
    up?.post(tap: .cghidEventTap)
}

func postText(_ text: String) {
    for scalar in text.unicodeScalars {
        var unicode = UniChar(scalar.value)
        let down = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true)
        down?.keyboardSetUnicodeString(stringLength: 1, unicodeString: &unicode)
        down?.post(tap: .cghidEventTap)
        let up = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false)
        up?.keyboardSetUnicodeString(stringLength: 1, unicodeString: &unicode)
        up?.post(tap: .cghidEventTap)
    }
}

do {
    let command = try arg(1)
    switch command {
    case "info":
        let display = CGMainDisplayID()
        let bounds = CGDisplayBounds(display)
        let trusted = AXIsProcessTrusted()
        let payload = """
        {"width":\(Int(bounds.width)),"height":\(Int(bounds.height)),"x":\(Int(bounds.origin.x)),"y":\(Int(bounds.origin.y)),"accessibilityTrusted":\(trusted)}
        """
        print(payload)
    case "prompt-accessibility":
        let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
        let trusted = AXIsProcessTrustedWithOptions(options)
        print("{\"accessibilityTrusted\":\(trusted)}")
    case "move":
        postMouseMove(try pointFromArgs(2))
    case "dragmove":
        postMouseDrag(try pointFromArgs(2), button: mouseButton(try arg(4)))
    case "down":
        postMouseButton(try pointFromArgs(2), button: mouseButton(try arg(4)), down: true)
    case "up":
        postMouseButton(try pointFromArgs(2), button: mouseButton(try arg(4)), down: false)
    case "click":
        let point = try pointFromArgs(2)
        let button = mouseButton(try arg(4))
        postClick(point, button: button)
    case "doubleclick":
        let point = try pointFromArgs(2)
        let button = mouseButton(try arg(4))
        postClick(point, button: button)
        usleep(90_000)
        postClick(point, button: button)
    case "wheel":
        postWheel(dx: try doubleArg(2), dy: try doubleArg(3))
    case "type":
        postText(try arg(2))
    case "key":
        let name = try arg(2).lowercased()
        guard let code = keyCodes[name] else {
            throw CommandError(description: "unsupported key: \(jsonEscape(name))")
        }
        let modifierArg = CommandLine.arguments.count > 3 ? CommandLine.arguments[3] : nil
        postKey(code: code, flags: flags(from: modifierArg))
    default:
        throw CommandError(description: "unknown command: \(jsonEscape(command))")
    }
} catch {
    fail(String(describing: error))
}
