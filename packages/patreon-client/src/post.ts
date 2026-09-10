/**
 * The post state machine: draft, body, attachments, access control. Then stop.
 *
 * There is no publish step and there will not be one. The tool produces a draft
 * and prints its URL; a human reads it and presses the button. That is not
 * timidity, it is the only version of this that is safe to run unattended
 * against a live creator account.
 *
 * Hand-written, like `media.ts`.
 *
 * WHAT THE CAPTURES SETTLED:
 *
 *   - the body format, which was the one genuinely open question. The editor
 *     sends HTML *and* a ProseMirror tree, both buildable from a markdown body.
 *     See `bodyStrategy` — the DOM-typing fallback is not needed.
 *   - there is no create call; a navigation mints the draft. See `createDraft`.
 *   - delete goes through the bulk endpoint even for one post, and returns an
 *     async job rather than doing the work inline.
 *
 * WHAT IS STILL MISSING: the update payload's own shape — which relationship
 * carries the attachments and in what order, and the two fields behind access
 * control and the adult flag. `tier-locked` has the first, `adult-on` the
 * second, and `adult-on` has not been captured yet.
 */

import { POST_CREATE, POST_DELETE, POST_UPDATE } from './endpoints.generated.ts'
import { NotCapturedError } from './errors.ts'
import type { ResolvedPost } from './manifest.ts'
import type { Session } from './session.ts'

export interface Draft {
  readonly id: string
  readonly url: string
}

/** How the body text gets into the post. Decided by the `text-only` capture. */
export type BodyStrategy =
  /** We can build the editor's document ourselves and PATCH it. */
  | { readonly kind: 'api' }
  /** We cannot; type it into the real editor and let it produce the tree. */
  | { readonly kind: 'editor' }
  /** Not yet known — which is the honest state until a capture says otherwise. */
  | { readonly kind: 'undecided' }

/**
 * ANSWERED by the `text-only` and `image-1` captures, and the answer is the
 * good one: the API path works, so no DOM typing is needed.
 *
 * The editor PATCHes two fields side by side:
 *
 *   data.attributes.content
 *     HTML. Literally
 *     `<p>paragraph one</p><p>paragraph <strong>two</strong> and a
 *      <a href="https://github.com/">link</a></p>`.
 *
 *   data.attributes.content_json_string
 *     the same document as a ProseMirror/TipTap tree, JSON-encoded *into a
 *     string*:
 *     `{"type":"doc","content":[{"type":"paragraph","content":[
 *       {"type":"text","text":"paragraph one"}]}]}`
 *
 * Both are sent, and the response echoes a `content_json_string` consistent
 * with what went in. A markdown body of paragraphs, bold and links maps onto
 * that tree directly, so `renderBody` can emit both and the hybrid fallback —
 * typing into the real editor — is not needed.
 *
 * TODO: build the pair from `ResolvedPost.body`. The shape is known; what is
 * not yet pinned is which marks the editor accepts beyond strong and link.
 */
export const bodyStrategy: BodyStrategy = { kind: 'api' }

/**
 * `data.attributes.post_type`, which the editor changes as attachments appear:
 * `text_only` for a body-only post, `image_file` once an image is attached.
 * Sent on the same PATCH as the attachments, so it is part of step 5.
 */
export type PostType = 'text_only' | 'image_file'

/**
 * Step 4 — create the draft.
 *
 * WHAT THE FIRST CAPTURE SHOWED, and it is not what this file assumed:
 * **there is no create call.** The `text-only` capture contains no POST that
 * makes a post. The draft is minted by *navigating* to the editor —
 * `GET /posts/new` answers 302, and the redirect lands on
 * `/<page>/posts/<id>/edit`, which is the first place the new post id exists.
 * Everything after that is `PATCH /api/posts/{id}`, six of them, autosaving.
 *
 * Two consequences worth writing down:
 *   - `POST_CREATE` may never be filled in. The create is a navigation, so this
 *     function will drive `session.page` and read the id back out of the URL
 *     rather than call anything.
 *   - opening the editor is itself a side effect. Every capture leaves a draft
 *     behind whether or not anything was typed.
 *
 * Not implemented on one capture. A second `text-only` run confirms the
 * redirect shape is stable and not a one-off experiment bucket — that is cheap,
 * and being wrong here means minting drafts on a live account.
 *
 * TODO(capture): confirm the 302 target shape, then implement by navigation.
 */
export function createDraft(_session: Session, _post: ResolvedPost): Promise<Draft> {
  return Promise.reject(
    new NotCapturedError(
      POST_CREATE === null
        ? 'the create step — the first capture says it is a navigation to /posts/new, not an API call, and that needs one more capture to confirm'
        : 'the create step',
      'text-only',
    ),
  )
}

/**
 * Step 5 — set access control, and confirm the attachments.
 *
 * "Attach" turns out to be the wrong verb. The `image-2` capture shows a second
 * image costing exactly one more `POST /api/media` and one more poll, with *no*
 * new relationship on the post — because a media record names its post at
 * creation time via `owner_id` / `owner_type: 'post'` / `owner_relationship:
 * 'main'`. Uploading it to the right owner is what attaches it. The post-side
 * PATCH only flips `post_type` from `text_only` to `image_file`.
 *
 * Access control is `data.relationships.access_rules.data`, an array of
 * `{ type: 'access-rule', id }` with a matching `included` entry. Public and
 * paid are two different access-rule ids — "public" is a rule, not the absence
 * of one. See the note on `tiers` in `manifest.ts`.
 *
 * STILL OPEN:
 *   - attachment *order*. Nothing order-shaped showed up in the image-2 diff,
 *     so it is either plain creation order or something that capture did not
 *     exercise. Worth one more capture that reorders and saves, deliberately.
 *   - the adult flag's field. `adult-on` has not been captured yet — it was
 *     blocked by this project's own checklist overlay covering the Settings
 *     sidebar, which is now fixed.
 */
export function updateDraft(
  _session: Session,
  _draft: Draft,
  _post: ResolvedPost,
  _mediaIds: readonly string[],
): Promise<void> {
  if (POST_UPDATE === null) return Promise.reject(new NotCapturedError('the post-update endpoint', 'text-only'))
  return Promise.reject(
    new NotCapturedError('the post-update payload: attachments, tiers and the adult flag', 'public-vs-tier'),
  )
}

/**
 * Delete a draft.
 *
 * Exists for fixture teardown and for nothing else. Every fixture creates a
 * real draft; a fixture that does not clean up leaves litter on a real creator
 * page. Drafts cannot reach patrons even if this fails, which is why the whole
 * capture matrix is draft-only.
 */
export function deleteDraft(_session: Session, _draft: Draft): Promise<void> {
  if (POST_DELETE === null) return Promise.reject(new NotCapturedError('the post-delete endpoint', 'text-only'))
  return Promise.reject(new NotCapturedError('the post-delete request', 'text-only'))
}

/**
 * There is no `publish`. Deliberately. If you are here to add one, the brief
 * says not to, and the reason is that nothing else in this pipeline has a human
 * checkpoint in it.
 */
