import { Body, Controller, Get, HttpCode, Param, Post, Query, Req } from '@nestjs/common';
import type { Principal } from '@pb/adapters';
import {
  documentCommandBody,
  documentListQuery,
  expectedDocumentGenerateBody,
  expectedDocumentListQuery,
  pageQuery,
} from '@pb/contracts';
import type {
  DocumentDetail,
  DocumentIndexResult,
  DocumentPage,
  DocumentPages,
  ExpectedDocumentGenerateResult,
  ExpectedDocumentPage,
} from '@pb/contracts';
import { CurrentPrincipal, Roles } from '../auth/principal.js';
import type { RequestWithPrincipal } from '../auth/principal.js';
import { parseOrProblem } from '../common/validate.js';
import { DocumentsService } from './documents.service.js';
import { ExpectedDocumentsService } from './expected.service.js';

/**
 * The document hub and the expected-document tracker (docs/04 M3). The role guard mirrors the
 * contract's route table; row-level security enforces it again below. The literal routes
 * (review-queue, index) are declared before the parameterized ones so they win the match.
 */
@Controller('api/v1')
export class DocumentsController {
  constructor(
    private readonly documents: DocumentsService,
    private readonly expected: ExpectedDocumentsService,
  ) {}

  @Get('documents')
  list(
    @Query() query: unknown,
    @CurrentPrincipal() principal: Principal,
    @Req() req: RequestWithPrincipal,
  ): Promise<DocumentPage> {
    const q = parseOrProblem(documentListQuery, query, 'query');
    return this.documents.list(principal, req.id ?? 'unknown', q);
  }

  @Get('documents/review-queue')
  reviewQueue(
    @Query() query: unknown,
    @CurrentPrincipal() principal: Principal,
    @Req() req: RequestWithPrincipal,
  ): Promise<DocumentPage> {
    const q = parseOrProblem(pageQuery, query, 'query');
    return this.documents.reviewQueue(principal, req.id ?? 'unknown', q);
  }

  @Post('documents/index')
  @Roles('operations')
  @HttpCode(200)
  index(
    @CurrentPrincipal() principal: Principal,
    @Req() req: RequestWithPrincipal,
  ): Promise<DocumentIndexResult> {
    return this.documents.index(principal, req.id ?? 'unknown');
  }

  @Get('documents/:id')
  detail(
    @Param('id') id: string,
    @CurrentPrincipal() principal: Principal,
    @Req() req: RequestWithPrincipal,
  ): Promise<DocumentDetail> {
    return this.documents.detail(principal, req.id ?? 'unknown', id);
  }

  @Get('documents/:id/pages')
  pages(
    @Param('id') id: string,
    @CurrentPrincipal() principal: Principal,
    @Req() req: RequestWithPrincipal,
  ): Promise<DocumentPages> {
    return this.documents.pages(principal, req.id ?? 'unknown', id);
  }

  @Post('documents/:id/commands')
  @Roles('deal_team', 'operations')
  @HttpCode(200)
  command(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentPrincipal() principal: Principal,
    @Req() req: RequestWithPrincipal,
  ): Promise<DocumentDetail> {
    const parsed = parseOrProblem(documentCommandBody, body, 'command');
    return this.documents.command(principal, req.id ?? 'unknown', id, parsed);
  }

  @Get('expected-documents')
  listExpected(
    @Query() query: unknown,
    @CurrentPrincipal() principal: Principal,
    @Req() req: RequestWithPrincipal,
  ): Promise<ExpectedDocumentPage> {
    const q = parseOrProblem(expectedDocumentListQuery, query, 'query');
    return this.expected.list(principal, req.id ?? 'unknown', q);
  }

  @Post('expected-documents/generate')
  @Roles('operations')
  @HttpCode(201)
  generate(
    @Body() body: unknown,
    @CurrentPrincipal() principal: Principal,
    @Req() req: RequestWithPrincipal,
  ): Promise<ExpectedDocumentGenerateResult> {
    const parsed = parseOrProblem(expectedDocumentGenerateBody, body, 'body');
    return this.expected.generate(principal, req.id ?? 'unknown', parsed);
  }
}
