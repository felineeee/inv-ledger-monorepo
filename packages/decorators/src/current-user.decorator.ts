import { createParamDecorator, ExecutionContext } from '@nestjs/common';

/**
 * Custom decorator to extract the authenticated user object (or a specific property)
 * attached to the request by authentication guards.
 *
 * @example
 * // Get full user payload
 * @Get('me')
 * getProfile(@CurrentUser() user: UserPayload) { ... }
 *
 * @example
 * // Extract specific property
 * @Get('id')
 * getUserId(@CurrentUser('id') userId: string) { ... }
 */
export const CurrentUser = createParamDecorator(
  (data: string | undefined, ctx: ExecutionContext) => {
    const request = ctx.switchToHttp().getRequest();
    const user = request.user;

    if (!user) {
      return null;
    }

    return data ? user[data] : user;
  },
);
