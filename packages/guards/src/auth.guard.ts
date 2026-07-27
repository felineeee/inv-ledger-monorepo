import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import jwt from 'jsonwebtoken';

export interface DecodedToken extends jwt.JwtPayload {
  user_id: string;
}

@Injectable()
export class AuthGuard implements CanActivate {
  private readonly jwtSecret: string;

  constructor(private readonly configService: ConfigService) {
    this.jwtSecret = this.configService.getOrThrow<string>('JWT_SECRET');
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const authHeader = request.headers['authorization'];

    if (!authHeader) {
      throw new UnauthorizedException('Missing authorization header');
    }

    const parts = authHeader.split(' ');
    if (parts.length !== 2 || parts[0].toLowerCase() !== 'bearer') {
      throw new UnauthorizedException('Invalid authorization header format');
    }

    const token = parts[1];

    try {
      const decoded = jwt.verify(token, this.jwtSecret, {
        algorithms: ['HS256'],
      }) as DecodedToken;

      if (!decoded.user_id) {
        throw new UnauthorizedException('Malformed token identity payload');
      }

      // Attaches user context to request, accessible via @CurrentUser()
      request.user = { id: decoded.user_id };

      return true;
    } catch {
      throw new UnauthorizedException(
        'Cryptographic token signature invalid or expired',
      );
    }
  }
}
