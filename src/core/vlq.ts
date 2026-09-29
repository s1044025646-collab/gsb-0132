import { AppError, ErrorCodes } from './errors.ts'

/** Decode one MIDI variable-length integer starting at offset. */
export function readVLQ(buf: Buffer, offset: number): { value: number; nextOffset: number } {
  let value = 0
  let pos = offset
  let byte: number
  do {
    if (pos >= buf.length) {
      throw new AppError(ErrorCodes.TRUNCATED_FILE, 'truncated variable-length integer', 400)
    }
    byte = buf[pos++]
    value = (value << 7) | (byte & 0x7f)
    if (value > 0xffffffff) {
      throw new AppError(ErrorCodes.INVALID_FILE, 'variable-length integer exceeds 32 bits')
    }
  } while (byte & 0x80)
  return { value, nextOffset: pos }
}

export function writeVLQ(value: number): Buffer {
  if (value < 0 || !Number.isInteger(value)) {
    throw new AppError(ErrorCodes.VALIDATION, `invalid VLQ value: ${value}`)
  }
  const bytes = [value & 0x7f]
  value >>>= 7
  while (value > 0) {
    bytes.push((value & 0x7f) | 0x80)
    value >>>= 7
  }
  return Buffer.from(bytes.reverse())
}
