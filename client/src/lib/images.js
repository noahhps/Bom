/* The conversation's own pictures, fetched once and handed out as addresses.
 *
 * An image is referred to everywhere by its id -- `img_...` on a slide,
 * `bom-image:img_...` in a page or a document -- and never by a web address.
 * This turns ids into something a browser can draw:
 *
 *   - a blob: URL, for drawing inside the app. The bytes come through the
 *     authenticated API (a bare <img src> cannot carry the bearer token), and
 *     are fetched once per id per session: an image's bytes never change.
 *
 *   - a data: URI, for anything that leaves the app or cannot reach it -- an
 *     exported deck, a downloaded page, and the sandboxed frame an HTML canvas
 *     is previewed in, which has an opaque origin and no token.
 */

export const IMAGE_ID = /^img_[A-Za-z0-9]+$/;
export const IMAGE_REF = /bom-image:(img_[A-Za-z0-9]+)/g;

const urls = new Map();
const datas = new Map();

/** A blob: URL for one image, cached. Rejects if it cannot be fetched. */
export function imageUrl(api, id) {
  if (!urls.has(id)) {
    const pending = api.imageBlob(id).then((blob) => URL.createObjectURL(blob));
    // A failure is not cached: the image may be uploaded a moment later.
    pending.catch(() => urls.delete(id));
    urls.set(id, pending);
  }
  return urls.get(id);
}

/** A data: URI for one image, cached. */
export function imageData(api, id) {
  if (!datas.has(id)) {
    const pending = api.imageBlob(id).then(
      (blob) =>
        new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result));
          reader.onerror = () => reject(reader.error);
          reader.readAsDataURL(blob);
        }),
    );
    pending.catch(() => datas.delete(id));
    datas.set(id, pending);
  }
  return datas.get(id);
}

/** Every image id a deck uses. */
export function deckImageIds(deck) {
  const ids = new Set();
  for (const slide of deck?.slides || []) {
    if (slide.image?.id) ids.add(slide.image.id);
    for (const layer of slide.board?.frame?.layers || []) {
      if (IMAGE_ID.test(layer?.image || "")) ids.add(layer.image);
    }
  }
  return [...ids];
}

/** Every image id a page or a document names. */
export function textImageIds(text) {
  return [...new Set([...String(text || "").matchAll(IMAGE_REF)].map((m) => m[1]))];
}

/** Resolve many ids at once to a map; ones that fail are left out. */
export async function resolveAll(ids, fetchOne) {
  const pairs = await Promise.all(
    ids.map((id) => fetchOne(id).then((url) => [id, url], () => null)),
  );
  return Object.fromEntries(pairs.filter(Boolean));
}

/** A page with its `bom-image:` references replaced by data: URIs, so it
 *  draws inside the sandboxed preview and on its own once downloaded. */
export async function inlinePageImages(api, html) {
  const ids = textImageIds(html);
  if (!ids.length) return html;
  const map = await resolveAll(ids, (id) => imageData(api, id));
  return html.replace(IMAGE_REF, (whole, id) => map[id] || whole);
}
