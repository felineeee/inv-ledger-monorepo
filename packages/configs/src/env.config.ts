import { plainToInstance, Type } from 'class-transformer';
import { IsEnum, IsNumber, IsString, validateSync } from 'class-validator';

export enum Environment {
  Development = 'development',
  Production = 'production',
  Test = 'test',
}

export class EnvironmentVariables {
  @IsEnum(Environment)
  APP_ENV: Environment = Environment.Development;

  @IsNumber()
  @Type(() => Number)
  HTTP_PORT: number = 8080;

  @IsString()
  DATABASE_URL!: string;

  @IsString()
  REDIS_URL!: string;

  @IsString()
  JWT_SECRET = 'defaultsupersecretkey';
}

export function validateEnv(config: Record<string, unknown>) {
  const validatedConfig = plainToInstance(EnvironmentVariables, config, {
    enableImplicitConversion: true,
  });

  // CRITICAL: skipMissingProperties must be false to catch missing DATABASE_URL / REDIS_URL
  const errors = validateSync(validatedConfig, {
    skipMissingProperties: false,
  });

  if (errors.length > 0) {
    throw new Error(`Config validation failure: ${errors.toString()}`);
  }

  return validatedConfig;
}
