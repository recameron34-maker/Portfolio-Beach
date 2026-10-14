import { Body, Controller, Get, HttpCode, Post, Req } from '@nestjs/common';
import type { Principal } from '@pb/adapters';
import { opsDropImportBody } from '@pb/contracts';
import type { IntakeExportList, IntakeImportResult } from '@pb/contracts';
import { CurrentPrincipal, Roles } from '../../auth/principal.js';
import type { RequestWithPrincipal } from '../../auth/principal.js';
import { parseOrProblem } from '../../common/validate.js';
import { OpsDropService } from './ops-drop.service.js';

/**
 * The operations workbook drop (docs/04 M2 ops-drop-import, SEC-9.1): workbooks parsed by
 * template signature onto the accounting layout, staged and reviewed on the intake file pages.
 * The role guard mirrors the contract's route table; row-level security enforces it again below.
 */
@Controller('api/v1/intake/ops-drop')
export class OpsDropController {
  constructor(private readonly service: OpsDropService) {}

  @Get('drops')
  @Roles('operations')
  drops(): Promise<IntakeExportList> {
    return this.service.drops();
  }

  @Post()
  @Roles('operations')
  @HttpCode(201)
  import(
    @Body() body: unknown,
    @CurrentPrincipal() principal: Principal,
    @Req() req: RequestWithPrincipal,
  ): Promise<IntakeImportResult> {
    // The upload limit is config, so the body schema is built with it here (decision 0010).
    const parsed = parseOrProblem(
      opsDropImportBody(this.service.maxWorkbookBase64Chars()),
      body,
      'import',
    );
    return this.service.import(principal, req.id ?? 'unknown', parsed);
  }
}
