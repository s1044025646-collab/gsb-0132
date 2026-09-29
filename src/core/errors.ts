export class AppError extends Error {
  code: string
  status: number
  details?: unknown
  constructor(
    code: string,
    message: string,
    status = 400,
    details?: unknown,
  ) {
    super(message)
    this.name = 'AppError'
    this.code = code
    this.status = status
    this.details = details
  }
}

export const ErrorCodes = {
  INVALID_FILE: 'INVALID_MIDI_FILE',
  SMPTE_UNSUPPORTED: 'SMPTE_TIME_FORMAT_UNSUPPORTED',
  TRUNCATED_FILE: 'TRUNCATED_MIDI_FILE',
  UNKNOWN_FORMAT: 'UNKNOWN_MIDI_FORMAT',
  PITCH_OUT_OF_RANGE: 'PITCH_OUT_OF_RANGE',
  NOT_FOUND: 'RESOURCE_NOT_FOUND',
  VALIDATION: 'VALIDATION_FAILED',
  CONFLICT: 'STATE_CONFLICT',
  PERCUSSION_PROTECTED: 'PERCUSSION_CHANNEL_PROTECTED',
} as const
