/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import * as DataStore from "@api/DataStore";
import { unzip } from "fflate";

export interface PersonalSticker {
    id: string;
    name: string;
    fileName: string;
    mediaType: string;
    size: number;
    url?: string;
    favorite?: boolean;
    bookmarkId?: string;
}

export interface StickerBookmark {
    id: string;
    name: string;
    icon: string;
    iconMediaType?: string;
}

const mediaTypes: Record<string, string> = {
    webm: "video/webm",
    mp4: "video/mp4",
    png: "image/png",
    apng: "image/apng",
    gif: "image/gif",
    webp: "image/webp",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    avif: "image/avif"
};

const iconMediaTypes: Record<string, string> = {
    ...mediaTypes,
    ico: "image/x-icon",
    svg: "image/svg+xml"
};

export const acceptedFiles = [...Object.keys(mediaTypes).map(extension => `.${extension}`), ".zip"].join(",");
export const acceptedIconFiles = Object.keys(iconMediaTypes).map(extension => `.${extension}`).join(",");

// Keep file bodies out of settings and the metadata index. Listing/searching a large
// collection should not load every video into memory or into Vencord settings backups.
let store: DataStore.UseStore | undefined;
let cachedBookmarks: StickerBookmark[] = [];

function getStore() {
    store ??= DataStore.createStore("VencordPersonalStickers", "stickers");
    return store;
}

function getMediaType(fileName: string) {
    const extension = fileName.split(".").pop()?.toLowerCase() ?? "";
    return Object.hasOwn(mediaTypes, extension) ? mediaTypes[extension] : undefined;
}

function getIconMediaType(fileName: string, fallbackType?: string) {
    const extension = fileName.split(".").pop()?.toLowerCase() ?? "";
    if (Object.hasOwn(iconMediaTypes, extension)) {
        return iconMediaTypes[extension];
    }
    if (fallbackType && (fallbackType.startsWith("image/") || fallbackType.startsWith("video/"))) {
        return fallbackType;
    }
    return undefined;
}

export function listStickers() {
    return DataStore.get<PersonalSticker[]>("index", getStore()).then(stickers => stickers ?? []);
}

export function getCachedBookmarks(): StickerBookmark[] {
    return cachedBookmarks;
}

export function listBookmarks() {
    return DataStore.get<StickerBookmark[]>("bookmarks", getStore()).then(bookmarks => {
        cachedBookmarks = bookmarks ?? [];
        return cachedBookmarks;
    });
}

export function getStickerFile(id: string) {
    return DataStore.get<Blob>(`file:${id}`, getStore());
}

export function getBookmarkIconFile(id: string) {
    return DataStore.get<Blob>(`bm-icon:${id}`, getStore());
}

export function getCachedGif(id: string) {
    return DataStore.get<Blob>(`gif:160:20:v1:${id}`, getStore());
}

export function cacheStickerGif(id: string, gif: Blob) {
    // Check inside the same transaction so closing/removing a sticker during
    // conversion cannot leave an orphaned cache entry.
    return editLibrary((stickers, objectStore) => {
        if (stickers.some(sticker => sticker.id === id)) {
            objectStore.put(gif, `gif:160:20:v1:${id}`);
        }
        return stickers;
    });
}

function editLibrary(edit: (stickers: PersonalSticker[], objectStore: IDBObjectStore) => PersonalSticker[]) {
    return getStore()("readwrite", objectStore => {
        const completed = DataStore.promisifyRequest(objectStore.transaction);
        const request = objectStore.get("index");

        request.onsuccess = () => {
            const stickers = edit(request.result ?? [], objectStore);
            objectStore.put(stickers, "index");
        };

        return completed;
    });
}

function editBookmarks(edit: (bookmarks: StickerBookmark[], objectStore: IDBObjectStore) => StickerBookmark[]) {
    return getStore()("readwrite", objectStore => {
        const completed = DataStore.promisifyRequest(objectStore.transaction);
        const request = objectStore.get("bookmarks");

        request.onsuccess = () => {
            const bookmarks = edit(request.result ?? [], objectStore);
            cachedBookmarks = bookmarks;
            objectStore.put(bookmarks, "bookmarks");
        };

        return completed;
    });
}

export async function createBookmark(name: string, icon: string, iconFile?: File): Promise<StickerBookmark> {
    const trimmed = name.trim();
    if (!trimmed) {
        throw new Error("Enter a bookmark name.");
    }
    const iconMediaType = iconFile ? getIconMediaType(iconFile.name, iconFile.type) : undefined;
    if (iconFile && !iconMediaType) {
        throw new Error(`Unsupported icon file: ${iconFile.name}`);
    }
    const bookmark: StickerBookmark = {
        id: crypto.randomUUID(),
        name: trimmed,
        icon: icon.trim() || "📁",
        iconMediaType
    };
    await editBookmarks((bookmarks, objectStore) => {
        if (iconFile && iconMediaType) {
            objectStore.put(iconFile.slice(0, iconFile.size, iconMediaType), `bm-icon:${bookmark.id}`);
        }
        return [...bookmarks, bookmark];
    });
    return bookmark;
}

export async function updateBookmark(id: string, name: string, icon: string, iconFile?: File | null) {
    const trimmed = name.trim();
    if (!trimmed) {
        throw new Error("Enter a bookmark name.");
    }
    const iconMediaType = iconFile ? getIconMediaType(iconFile.name, iconFile.type) : undefined;
    if (iconFile && !iconMediaType) {
        throw new Error(`Unsupported icon file: ${iconFile.name}`);
    }
    await editBookmarks((bookmarks, objectStore) => bookmarks.map(b => {
        if (b.id !== id) return b;

        if (iconFile && iconMediaType) {
            objectStore.put(iconFile.slice(0, iconFile.size, iconMediaType), `bm-icon:${id}`);
            return { ...b, name: trimmed, icon: icon.trim() || "📁", iconMediaType };
        }
        if (iconFile === null) {
            objectStore.delete(`bm-icon:${id}`);
            return { ...b, name: trimmed, icon: icon.trim() || "📁", iconMediaType: undefined };
        }
        return { ...b, name: trimmed, icon: icon.trim() || "📁" };
    }));
}

export async function moveBookmark(id: string, direction: -1 | 1) {
    await editBookmarks(bookmarks => {
        const index = bookmarks.findIndex(b => b.id === id);
        const target = index + direction;
        if (index === -1 || target < 0 || target >= bookmarks.length) {
            return bookmarks;
        }
        const next = [...bookmarks];
        [next[index], next[target]] = [next[target], next[index]];
        return next;
    });
}

export async function deleteBookmark(id: string, deleteStickers = false) {
    await getStore()("readwrite", objectStore => {
        const completed = DataStore.promisifyRequest(objectStore.transaction);
        const bookmarksReq = objectStore.get("bookmarks");
        const indexReq = objectStore.get("index");

        bookmarksReq.onsuccess = () => {
            const bookmarks: StickerBookmark[] = bookmarksReq.result ?? [];
            const next = bookmarks.filter(b => b.id !== id);
            cachedBookmarks = next;
            objectStore.delete(`bm-icon:${id}`);
            objectStore.put(next, "bookmarks");
        };

        indexReq.onsuccess = () => {
            const stickers: PersonalSticker[] = indexReq.result ?? [];
            if (deleteStickers) {
                const kept: PersonalSticker[] = [];
                for (const sticker of stickers) {
                    if (sticker.bookmarkId === id) {
                        objectStore.delete(`file:${sticker.id}`);
                        objectStore.delete(`gif:160:20:v1:${sticker.id}`);
                    } else {
                        kept.push(sticker);
                    }
                }
                objectStore.put(kept, "index");
            } else {
                objectStore.put(
                    stickers.map(s => s.bookmarkId === id ? { ...s, bookmarkId: undefined } : s),
                    "index"
                );
            }
        };

        return completed;
    });
}

export async function importSticker(file: File, bookmarkId?: string) {
    const mediaType = getMediaType(file.name);
    if (!mediaType) {
        throw new Error(`Unsupported file: ${file.name}`);
    }
    if (!file.size) {
        throw new Error(`The file is empty: ${file.name}`);
    }

    const sticker: PersonalSticker = {
        id: crypto.randomUUID(),
        name: file.name.replace(/\.[^.]+$/, ""),
        fileName: file.name,
        mediaType,
        size: file.size,
        bookmarkId
    };

    // Commit the metadata and file together, including when storage runs out.
    await editLibrary((stickers, objectStore) => {
        objectStore.put(file.slice(0, file.size, mediaType), `file:${sticker.id}`);
        return [...stickers, sticker];
    });
}

export async function extractZipStickers(file: File): Promise<File[]> {
    const buffer = new Uint8Array(await file.arrayBuffer());
    const entries = await new Promise<Record<string, Uint8Array>>((resolve, reject) => {
        unzip(buffer, (err, data) => {
            if (err) reject(err);
            else resolve(data);
        });
    });

    const extracted: File[] = [];
    for (const [path, bytes] of Object.entries(entries)) {
        if (path.endsWith("/") || path.includes("__MACOSX/")) continue;
        const baseName = path.split("/").pop() ?? "";
        if (!baseName || baseName.startsWith(".")) continue;
        const mediaType = getMediaType(baseName);
        if (!mediaType || !bytes.byteLength) continue;
        extracted.push(new File([bytes as Uint8Array<ArrayBuffer>], baseName, { type: mediaType }));
    }
    return extracted;
}

export async function toggleFavoriteSticker(id: string) {
    await editLibrary(stickers => stickers.map(sticker => {
        if (sticker.id === id) {
            return { ...sticker, favorite: !sticker.favorite };
        }
        return sticker;
    }));
}

export async function setStickerBookmark(id: string, bookmarkId?: string) {
    await editLibrary(stickers => stickers.map(sticker => {
        if (sticker.id === id) {
            return { ...sticker, bookmarkId };
        }
        return sticker;
    }));
}

const mimeToExtension: Record<string, string> = {
    "video/webm": "webm",
    "video/mp4": "mp4",
    "image/png": "png",
    "image/apng": "apng",
    "image/gif": "gif",
    "image/webp": "webp",
    "image/jpeg": "jpg",
    "image/avif": "avif"
};

export async function importStickerFromUrl(inputUrl: string, preferredName?: string, bookmarkId?: string) {
    const parsed = new URL(inputUrl.trim());
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
        throw new Error("Use an HTTP or HTTPS media URL.");
    }

    const pathBase = decodeURIComponent(parsed.pathname.split("/").pop() ?? "").trim();
    const pathMediaType = getMediaType(pathBase);

    try {
        const res = await fetch(parsed.href);
        if (res.ok) {
            const blob = await res.blob();
            const rawMime = blob.type.split(";")[0].trim().toLowerCase();
            const ext = mimeToExtension[rawMime] ?? (pathMediaType ? pathBase.split(".").pop()!.toLowerCase() : "gif");
            const mediaType = mimeToExtension[rawMime] ? rawMime : (pathMediaType ?? "image/gif");
            const cleanBase = (preferredName?.trim() || pathBase.replace(/\.[^.]+$/, "") || "sticker").replace(/\.[^.]+$/, "");
            const fileName = `${cleanBase}.${ext}`;
            const file = new File([blob], fileName, { type: mediaType });
            await importSticker(file, bookmarkId);
            return;
        }
    } catch {
        // Fallback to linked sticker if CORS blocks direct fetch
    }

    const fallbackName = preferredName?.trim() || pathBase.replace(/\.[^.]+$/, "") || "sticker";
    if (pathMediaType) {
        await addLinkedSticker(parsed.href, fallbackName, bookmarkId);
        return;
    }

    // If URL has no recognized extension (e.g. Tenor page link), store as GIF link if possible
    const sticker: PersonalSticker = {
        id: crypto.randomUUID(),
        name: fallbackName,
        fileName: `${fallbackName}.gif`,
        mediaType: "image/gif",
        size: 0,
        url: parsed.href,
        bookmarkId
    };
    await editLibrary(stickers => [...stickers, sticker]);
}

export async function addLinkedSticker(input: string, name: string, bookmarkId?: string) {
    const url = new URL(input.trim());
    if (url.protocol !== "https:" && url.protocol !== "http:") {
        throw new Error("Use an HTTP or HTTPS media URL.");
    }
    if (url.username || url.password) {
        throw new Error("Media URLs must not contain login credentials.");
    }

    const fileName = decodeURIComponent(url.pathname.split("/").pop() ?? "");
    const mediaType = getMediaType(fileName);
    if (!mediaType) {
        throw new Error("Use a direct media URL ending in .webm, .mp4, .png, .apng, .gif, .webp, .jpg, .jpeg or .avif.");
    }

    const sticker: PersonalSticker = {
        id: crypto.randomUUID(),
        name: name.trim() || fileName.replace(/\.[^.]+$/, ""),
        fileName,
        mediaType,
        size: 0,
        url: url.href,
        bookmarkId
    };

    await editLibrary(stickers => [...stickers, sticker]);
}

export async function renameSticker(id: string, name: string) {
    const trimmed = name.trim();
    if (!trimmed) {
        throw new Error("Enter a sticker name.");
    }

    await editLibrary(stickers => stickers.map(sticker => {
        if (sticker.id === id) {
            return { ...sticker, name: trimmed };
        }
        return sticker;
    }));
}

export async function removeSticker(id: string) {
    await editLibrary((stickers, objectStore) => {
        objectStore.delete(`file:${id}`);
        objectStore.delete(`gif:160:20:v1:${id}`);
        return stickers.filter(sticker => sticker.id !== id);
    });
}
