/**
 * The library the desktop app depends on.
 *
 * No Playwright here and none in the dependency tree — the caller connects a
 * browser and hands in the page. See `session.ts` for why there is no auth
 * module either.
 */

export { ApiError, ManifestError, NotCapturedError, SessionError } from './errors.ts'
export { jobSchema, loadJob } from './job.ts'
export type { Job } from './job.ts'
export { kindOf, loadManifest, manifestSchema } from './manifest.ts'
export type { Manifest, ResolvedMedia, ResolvedPost } from './manifest.ts'
export { assertLoggedIn, attach, fromCookies } from './session.ts'
export type { BrowserLike, ContextLike, PageLike, Session } from './session.ts'
export { cookiesFrom, cookieTransport, identityFrom, pageTransport } from './transport.ts'
export type { Identity, Transport, TransportRequest, TransportResponse } from './transport.ts'
export { BodyError, renderBody } from './body.ts'
export type { RenderedBody } from './body.ts'
export { accessRulesFor, assertAdultMatchesCampaign, readCampaign } from './campaign.ts'
export type { AccessRule, Campaign } from './campaign.ts'
export { call, callOrThrow, endpointPath, JSON_API, required } from './call.ts'
export type { CallResult, CallSpec } from './call.ts'
export { contentTypeOf, createMedia, multipartBody, pollUntil, uploadBytes, waitUntilReady } from './media.ts'
export type { PollOptions, UploadTarget } from './media.ts'
export { bodyStrategy, createDraft, deleteDraft, updateDraft } from './post.ts'
export type { BodyStrategy, Draft, Navigator, PostMetadata, PostType } from './post.ts'
export { runPost } from './run.ts'
export type { RunOptions, RunResult } from './run.ts'
export { describePlan, planRun } from './plan.ts'
export type { Plan, Step } from './plan.ts'
export { emptyState, isCurrent, loadState, pruneState, saveState, statePath } from './state.ts'
export type { MediaPhase, MediaState, RunState } from './state.ts'
export { CAPTURED_FROM } from './endpoints.generated.ts'
