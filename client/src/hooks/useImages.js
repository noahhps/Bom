import { useCallback, useEffect, useState } from "react";

import { useApi } from "../lib/api-context";
import { readFile } from "../lib/files";
import { imageUrl, resolveAll } from "../lib/images";

/** blob: URLs for a set of image ids, as a map that fills in as they load. */
export function useImageUrls(ids) {
  const api = useApi();
  const key = [...ids].sort().join(",");
  const [map, setMap] = useState({});
  useEffect(() => {
    if (!api || !key) return undefined;
    let live = true;
    resolveAll(key.split(","), (id) => imageUrl(api, id)).then((next) => {
      if (live) setMap(next);
    });
    return () => {
      live = false;
    };
  }, [api, key]);
  return map;
}

/**
 * A conversation's picture library: listed, uploaded to, relabelled.
 *
 * Listing also brings in the images attached in the chat -- the server does
 * that on the first request -- so the picker offers exactly what the model's
 * list_images does.
 */
export function useSessionImages(sessionId) {
  const api = useApi();
  const [images, setImages] = useState([]);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    if (!api || !sessionId) return [];
    const data = await api.listImages(sessionId);
    setImages(data.images || []);
    return data.images || [];
  }, [api, sessionId]);

  useEffect(() => {
    refresh().catch(() => {});
  }, [refresh]);

  const upload = useCallback(
    async (file) => {
      setError("");
      try {
        const { name, data } = await readFile(file);
        const image = await api.uploadImage(sessionId, { name, data });
        await refresh();
        return image;
      } catch (problem) {
        setError(problem.message || "Could not add that image.");
        return null;
      }
    },
    [api, sessionId, refresh],
  );

  const relabel = useCallback(
    async (id, alt) => {
      await api.updateImage(id, { alt });
      await refresh();
    },
    [api, refresh],
  );

  return { images, error, refresh, upload, relabel };
}
