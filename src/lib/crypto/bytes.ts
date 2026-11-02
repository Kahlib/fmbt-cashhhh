// Small helpers for turning text and bytes into each other. Encryption works
// on bytes, but the database stores text, so every key, IV and ciphertext
// passes through here on its way in or out.
//
// `Uint8Array<ArrayBuffer>` is a list of bytes. Web Crypto only accepts byte
// lists backed by an ordinary ArrayBuffer, so the helpers promise that type.
export type Bytes = Uint8Array<ArrayBuffer>

// Text to bytes, as UTF-8.
export function utf8(text: string): Bytes {
  return new TextEncoder().encode(text)
}

// Bytes back to text. `fatal: true` throws on broken UTF-8 instead of quietly
// swapping in replacement characters.
export function fromUtf8(bytes: Bytes): string {
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
}

// Bytes to base64, the form the database stores IVs and ciphertext in.
export function toBase64(bytes: Bytes): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

// Base64 back to bytes. Anything that isn't strict base64 throws, so junk from
// the server never gets as far as the decryption step.
export function fromBase64(text: string): Bytes {
  if (text.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(text)) {
    throw new Error('Not valid base64.')
  }
  const binary = atob(text)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

// Bytes to lowercase hex: two characters per byte. Login tokens and recovery
// proofs travel as hex.
export function toHex(bytes: Bytes): string {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
}

// Lowercase hex back to bytes. Anything else throws.
export function fromHex(text: string): Bytes {
  if (text.length % 2 !== 0 || !/^[0-9a-f]*$/.test(text)) throw new Error('Not valid hex.')
  const bytes = new Uint8Array(text.length / 2)
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(text.slice(i * 2, i * 2 + 2), 16)
  return bytes
}

// Fresh random bytes from the browser's secure random generator. Never
// Math.random(), which is predictable (fmbt-security, section 1).
export function randomBytes(length: number): Bytes {
  return crypto.getRandomValues(new Uint8Array(length))
}
