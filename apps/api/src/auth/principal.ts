import {
  CanActivate,
  createParamDecorator,
  ExecutionContext,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import type { Principal } from '@pb/adapters';
import { ProblemError } from '../common/problem.js';

export interface RequestWithPrincipal extends Request {
  id?: string;
  principal?: Principal;
  mockIdentity?: boolean;
}

export const IS_PUBLIC = 'pb:public';
export const ROLES = 'pb:roles';

/** Marks a route as reachable without a principal (health, mock sign-in list). */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC, true);
/** Restricts a route to roles; records a caller may not see still return 404, this is for operations. */
export const Roles = (...roles: string[]): MethodDecorator & ClassDecorator =>
  SetMetadata(ROLES, roles);

export const CurrentPrincipal = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): Principal => {
    const req = ctx.switchToHttp().getRequest<RequestWithPrincipal>();
    if (req.principal === undefined)
      throw new ProblemError(401, 'unauthenticated', 'Sign in to continue');
    return req.principal;
  },
);

/** Checks the resolved principal and route roles. The API enforces roles here and Postgres RLS enforces them again (SEC-5.1). */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic =
      this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
        context.getHandler(),
        context.getClass(),
      ]) ?? false;
    const req = context.switchToHttp().getRequest<RequestWithPrincipal>();
    if (isPublic) return true;
    if (req.principal === undefined)
      throw new ProblemError(401, 'unauthenticated', 'Sign in to continue');
    const roles =
      this.reflector.getAllAndOverride<string[]>(ROLES, [
        context.getHandler(),
        context.getClass(),
      ]) ?? [];
    if (
      roles.length > 0 &&
      !roles.some((r) => req.principal?.roles.includes(r as Principal['roles'][number]))
    ) {
      throw new ProblemError(403, 'forbidden', 'This operation needs a role you do not hold');
    }
    return true;
  }
}
