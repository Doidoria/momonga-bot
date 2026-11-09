/** 사용자에게 그대로 보여줄 문구가 있는 에러 */
export class UserFacingError extends Error {
  constructor(
    readonly userMessage: string,
    detail?: string,
  ) {
    super(detail ?? userMessage);
    this.name = 'UserFacingError';
  }
}
