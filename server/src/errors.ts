export class AppError extends Error {
  statusCode: number;
  code: string;
  details?: unknown;

  constructor(statusCode: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (message = '请求参数无效', details?: unknown) => new AppError(400, 'VALIDATION_ERROR', message, details);
export const unauthorized = (code = 'AUTH_INVALID', message = '认证失败') => new AppError(401, code, message);
export const forbidden = (code: string, message: string) => new AppError(403, code, message);
export const conflict = (code: string, message: string, details?: unknown) => new AppError(409, code, message, details);
