/**
 * The post state machine: draft, body, attachments, access control. Then stop.
 *
 * There is no publish step and there will not be one. The tool produces a draft
 * and prints its URL; a human reads it and presses the button. That is not
 * timidity, it is the only version of this that is safe to run unattended
 * against a live creator account.
 *
 * Hand-written, like `media.ts`. Every payload below is transcribed from a
 * capture rather than reconstructed from what JSON:API usually looks like.
 */

import { renderBody } from './body.ts'
import { accessRulesFor, type Campaign } from './campaign.ts'
import { call, callOrThrow, endpointPath, required } from './call.ts'
import { POST_CREATE, POST_DELETE, POST_UPDATE } from './endpoints.generated.ts'
import type { ResolvedPost } from './manifest.ts'
import type { Session } from './session.ts'

export interface Draft {
  readonly id: string
  readonly url: string
}

/** How the body text gets into the post. Settled by the `text-only` capture. */
export type BodyStrategy =
  /** We can build the editor's document ourselves and PATCH it. */
  | { readonly kind: 'api' }
  /** We cannot; type it into the real editor and let it produce the tree. */
  | { readonly kind: 'editor' }
  /** Not yet known — which is the honest state until a capture says otherwise. */
  | { readonly kind: 'undecided' }

/**
 * The API path works, so the DOM-typing fallback the brief hedged on is not
 * needed. See `body.ts` for the two forms the editor sends and why each shape
 * is what it is.
 */
export const bodyStrategy: BodyStrategy = { kind: 'api' }

/** `data.attributes.post_type`, which the editor changes as attachments appear. */
export type PostType = 'text_only' | 'image_file'

/**
 * `data.attributes.post_metadata`, sent whole on every update.
 *
 * `image_order` is the attachment order — media ids as strings, in display
 * order. `platform` is always present and always empty in these captures; it is
 * carried rather than understood, because dropping a field the editor always
 * sends is a change we have no evidence is safe.
 */
export interface PostMetadata {
  readonly platform: Record<string, never>
  readonly image_order?: readonly string[]
}

/**
 * Attributes the editor sends on every autosave and never varies.
 *
 * Compared across the public and the tier-locked captures: identical in both,
 * `is_paid` included — which is the surprise. Access is expressed *entirely*
 * through the `access_rules` relationship, and `is_paid` stays false in the
 * request even for a post locked to a tier; the server derives it.
 *
 * They are sent because the editor sends them. Whether a PATCH carrying only
 * the fields we care about would merge, or would blank the rest, is not
 * something any capture answers — and finding out experimentally costs a real
 * post on a real page.
 */
const CONSTANT_ATTRIBUTES = {
  allow_preview_in_rss: true,
  comments_write_access_level: 'all',
  is_header_media_free: null,
  is_monetized: false,
  is_paid: false,
  is_preview_blurred: true,
  new_post_email_type: 'full_post',
  paywall_display: 'post_layout',
  preview_asset_type: 'default',
  tags: { publish: false },
  thumbnail_position: null,
} as const

/**
 * Query string the editor puts on every post PATCH.
 *
 * Carried verbatim. `include=[]` with `json-api-use-default-includes=false` is
 * what keeps the response from dragging half the campaign along with it.
 */
const POST_QUERY = {
  'json-api-version': '1.0',
  'json-api-use-default-includes': 'false',
  include: '[]',
}

/**
 * Step 4 — create the draft.
 *
 * There is no create call. The draft is minted by *navigating* to the editor:
 * `GET /posts/new` answers 302 and the redirect lands on
 * `/<page>/posts/<id>/edit`, which is the first place the new post id exists.
 * Everything after that is `PATCH /api/posts/{id}`.
 *
 * From Node that is a plain GET with redirects off: the `Location` header *is*
 * the answer, and following it would mean fetching the whole editor page and
 * hunting the id in a megabyte of HTML.
 *
 * Note the side effect: asking for `/posts/new` creates a draft whether or not
 * anything after it succeeds. That is what `.state.json` is for, and what
 * `patreon capture cleanup` sweeps up.
 */
export async function createDraft(session: Session): Promise<Draft> {
  const endpoint = required(POST_CREATE, 'the create step', 'text-only')
  // `redirect: 'manual'` on purpose: the 302's Location *is* the answer. Left
  // to follow it, this would fetch the whole editor page and then have to find
  // the id in a megabyte of HTML.
  const result = await call(session, {
    method: 'GET',
    path: endpoint.path,
    headers: { accept: 'text/html' },
    manualRedirect: true,
  })

  const landed = result.headers['location'] ?? ''
  const id = /\/posts\/(\d+)(?:\/|$|\?)/.exec(landed)?.[1]
  if (id === undefined) {
    throw new Error(
      `${endpoint.path} did not redirect to a post editor (${result.status}, location: ${landed || '(none)'}).
` +
        'If that is a login wall the session has expired: run `pnpm patreon auth`.',
    )
  }
  return { id, url: new URL(landed, session.origin).toString() }
}

/**
 * Step 5 — the body, the ordering, the access control, in one PATCH.
 *
 * "Attach" is the wrong verb and there is no attach call: a media record names
 * its post at creation via `owner_id`, so uploading it to the right owner is
 * what attaches it. All this does on that front is state the order.
 */
export async function updateDraft(
  session: Session,
  draft: Draft,
  post: ResolvedPost,
  campaign: Campaign,
  mediaIds: readonly string[],
): Promise<void> {
  const endpoint = required(POST_UPDATE, 'the post-update endpoint', 'text-only')
  const body = renderBody(post.body)
  const rules = accessRulesFor(post, campaign)
  const metadata: PostMetadata =
    mediaIds.length === 0 ? { platform: {} } : { platform: {}, image_order: [...mediaIds] }
  const postType: PostType = mediaIds.length === 0 ? 'text_only' : 'image_file'

  await callOrThrow(session, {
    method: endpoint.method,
    path: endpointPath(endpoint, { id: draft.id }),
    query: POST_QUERY,
    body: {
      data: {
        type: 'post',
        attributes: {
          ...CONSTANT_ATTRIBUTES,
          title: post.title,
          content: body.content,
          content_json_string: body.contentJsonString,
          post_type: postType,
          post_metadata: metadata,
        },
        relationships: {
          // Both spellings, because the editor sends both: a singular object and
          // a plural array naming the same rules. Which one the server actually
          // reads is not something a capture can show, so neither is dropped.
          'access-rule': { data: { type: 'access-rule', id: rules[0] } },
          access_rules: { data: rules.map((id) => ({ id, type: 'access-rule' })) },
          user_defined_tags: { data: [] },
          collections: { data: [] },
        },
      },
      included: rules.map((id) => ({ type: 'access-rule', id, attributes: {} })),
      // The editor's own words. The post stays a draft either way, and
      // `send_notifications` only takes effect when a human publishes.
      meta: { auto_save: true, send_notifications: true },
    },
  })
}

/**
 * Delete a draft.
 *
 * Goes through the bulk endpoint even for a single post, and answers 201 with
 * an async job rather than doing the work inline — `is_completed: false` and a
 * job id. Nothing here waits for it: this is teardown, and a draft that lingers
 * a few seconds more harms nobody.
 *
 * `post_ids` are numbers in the capture while `campaign_id` is a string.
 * Transcribed rather than tidied, because that asymmetry is the server's.
 */
export async function deleteDraft(session: Session, draft: Draft, campaignId: string): Promise<void> {
  const endpoint = required(POST_DELETE, 'the post-delete endpoint', 'cleanup')
  const result = await call(session, {
    method: endpoint.method,
    path: endpoint.path,
    body: {
      data: {
        type: 'bulk-post-operation',
        attributes: { filters: { post_ids: [Number(draft.id)], campaign_id: campaignId } },
      },
    },
  })
  if (!result.ok) {
    throw new Error(`could not delete draft ${draft.id} (${result.status}): ${result.text.slice(0, 300)}`)
  }
}

/**
 * There is no `publish`. Deliberately. If you are here to add one, the brief
 * says not to, and the reason is that nothing else in this pipeline has a human
 * checkpoint in it.
 */
