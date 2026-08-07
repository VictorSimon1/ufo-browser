import Foundation
import Security

guard CommandLine.arguments.count == 1 else {
  exit(1)
}

let service = "Chrome Safe Storage"

let query: [CFString: Any] = [
  kSecClass: kSecClassGenericPassword,
  kSecAttrService: service,
  kSecReturnData: true,
  kSecMatchLimit: kSecMatchLimitOne,
]

var result: CFTypeRef?
let status = SecItemCopyMatching(query as CFDictionary, &result)
switch status {
case errSecSuccess:
  guard let data = result as? Data, !data.isEmpty else {
    exit(4)
  }
  FileHandle.standardOutput.write(data)
case errSecUserCanceled, errSecAuthFailed, errSecInteractionNotAllowed:
  exit(2)
case errSecItemNotFound:
  exit(3)
default:
  exit(4)
}
