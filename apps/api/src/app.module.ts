import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { AnalyticsController } from './analytics/analytics.controller.js';
import { AnalyticsService } from './analytics/analytics.service.js';
import { AuditController } from './audit/audit.controller.js';
import { AuditService } from './audit/audit.service.js';
import { AuthController } from './auth/auth.controller.js';
import { CapitalController } from './capital/capital.controller.js';
import { CapitalService } from './capital/capital.service.js';
import { IdentityMiddleware } from './auth/identity.middleware.js';
import { AuthGuard } from './auth/principal.js';
import { ProblemFilter } from './common/problem.js';
import { ADAPTERS, CONFIG, DB_HANDLE, DEFINITIONS, LOGGER } from './common/tokens.js';
import type { Runtime } from './composition.js';
import { DataController } from './data/data.controller.js';
import { DbService } from './db/db.service.js';
import { FlagsController } from './flags/flags.controller.js';
import { FlagsService } from './flags/flags.service.js';
import { HealthController } from './health/health.controller.js';
import { PerformanceController } from './performance/performance.controller.js';
import { PerformanceService } from './performance/performance.service.js';
import { PortfolioController } from './portfolio/portfolio.controller.js';
import { PortfolioService } from './portfolio/portfolio.service.js';
import { ReportsController } from './reports/reports.controller.js';
import { ReportsService } from './reports/reports.service.js';
import { SponsorsController } from './sponsors/sponsors.controller.js';
import { SponsorsService } from './sponsors/sponsors.service.js';
import { ValuationsController } from './valuations/valuations.controller.js';
import { ValuationsService } from './valuations/valuations.service.js';
import { VehiclesController } from './vehicles/vehicles.controller.js';
import { VehiclesService } from './vehicles/vehicles.service.js';

/** Every controller the API serves; the contract parity test reflects on this list. */
export const CONTROLLERS = [
  HealthController,
  AuthController,
  FlagsController,
  PortfolioController,
  DataController,
  PerformanceController,
  VehiclesController,
  SponsorsController,
  ValuationsController,
  CapitalController,
  AnalyticsController,
  ReportsController,
  AuditController,
] as const;

@Module({})
export class AppModule implements NestModule {
  static forRuntime(runtime: Runtime): DynamicModule {
    return {
      module: AppModule,
      controllers: [...CONTROLLERS],
      providers: [
        { provide: CONFIG, useValue: runtime.config },
        { provide: DB_HANDLE, useValue: runtime.db },
        { provide: ADAPTERS, useValue: runtime.adapters },
        { provide: LOGGER, useValue: runtime.logger },
        { provide: DEFINITIONS, useValue: runtime.definitions },
        DbService,
        FlagsService,
        PortfolioService,
        PerformanceService,
        VehiclesService,
        SponsorsService,
        ValuationsService,
        CapitalService,
        AnalyticsService,
        ReportsService,
        AuditService,
        { provide: APP_GUARD, useClass: AuthGuard },
        { provide: APP_FILTER, useClass: ProblemFilter },
      ],
    };
  }

  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(IdentityMiddleware).forRoutes('*path');
  }
}
