/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Button } from "@components/Button";
import { DeleteIcon, DownArrow, FolderIcon, ImageIcon, LinkIcon, PencilIcon, PlusIcon, RightArrow, SearchIcon, StarFilled, StarOutlined, UpArrowIcon } from "@components/Icons";
import { RenderModalProps } from "@vencord/discord-types";
import { ChannelStore, ContextMenuApi, DraftType, Menu, Modal, ScrollerThin, SelectedChannelStore, Tooltip, UploadHandler, useEffect, useRef, useState } from "@webpack/common";

import { convertToStickerGif } from "./convertToGif";
import { settings } from "./index";
import {
    acceptedFiles,
    acceptedIconFiles,
    addLinkedSticker,
    cacheStickerGif,
    createBookmark,
    deleteBookmark,
    extractZipStickers,
    getBookmarkIconFile,
    getCachedGif,
    getStickerFile,
    importSticker,
    listBookmarks,
    listStickers,
    moveBookmark,
    PersonalSticker,
    removeSticker,
    renameSticker,
    setStickerBookmark,
    StickerBookmark,
    toggleFavoriteSticker,
    updateBookmark
} from "./storage";

const BOOKMARK_ICONS = ["📁", "🐱", "🐶", "🐸", "🦊", "🐼", "✨", "🔥", "❤️", "😂", "🎉", "🎮", "🎵", "💀", "👍", "🌈"];

function errorMessage(error: unknown) {
    if (error instanceof DOMException && error.name === "QuotaExceededError") {
        return "Local storage is full. Free some disk space or remove stickers, then try again.";
    }
    return error instanceof Error ? error.message : String(error);
}

function StickerPreview({ sticker, alwaysAnimate }: { sticker: PersonalSticker; alwaysAnimate: boolean; }) {
    const [source, setSource] = useState(sticker.url);
    const [failed, setFailed] = useState(false);
    const videoRef = useRef<HTMLVideoElement>(null);

    useEffect(() => {
        if (sticker.url) {
            return;
        }

        let disposed = false;
        let objectUrl: string | undefined;

        getStickerFile(sticker.id).then(file => {
            if (disposed) {
                return;
            }
            if (!file) {
                setFailed(true);
                return;
            }
            objectUrl = URL.createObjectURL(file);
            setSource(objectUrl);
        }).catch(() => {
            if (!disposed) {
                setFailed(true);
            }
        });

        return () => {
            disposed = true;
            if (objectUrl) {
                URL.revokeObjectURL(objectUrl);
            }
        };
    }, [sticker.id, sticker.url]);

    useEffect(() => {
        const video = videoRef.current;
        if (!video || !source) return;
        if (alwaysAnimate) {
            void video.play().catch(() => {});
        } else {
            video.pause();
        }
    }, [alwaysAnimate, source]);

    if (failed) {
        return <span className="vc-ps-preview-error">Error</span>;
    }
    if (!source) {
        return <span className="vc-ps-preview-error">…</span>;
    }

    if (sticker.mediaType.startsWith("video/")) {
        return (
            <video
                ref={videoRef}
                src={source}
                muted
                loop
                playsInline
                autoPlay={alwaysAnimate}
                preload="metadata"
                aria-label={sticker.name}
                onMouseEnter={() => {
                    if (!alwaysAnimate) {
                        void videoRef.current?.play().catch(() => {});
                    }
                }}
                onMouseLeave={() => {
                    if (!alwaysAnimate) {
                        videoRef.current?.pause();
                    }
                }}
                onError={() => setFailed(true)}
            />
        );
    }

    return <img src={source} alt={sticker.name} loading="lazy" onError={() => setFailed(true)} />;
}

function BookmarkIconView({
    bookmark,
    alwaysAnimate,
    className
}: {
    bookmark: StickerBookmark;
    alwaysAnimate: boolean;
    className?: string;
}) {
    const [source, setSource] = useState<string>();

    useEffect(() => {
        if (!bookmark.iconMediaType) {
            setSource(undefined);
            return;
        }

        let disposed = false;
        let objectUrl: string | undefined;

        getBookmarkIconFile(bookmark.id).then(blob => {
            if (disposed || !blob) return;
            objectUrl = URL.createObjectURL(blob);
            setSource(objectUrl);
        }).catch(() => {});

        return () => {
            disposed = true;
            if (objectUrl) {
                URL.revokeObjectURL(objectUrl);
            }
        };
    }, [bookmark.id, bookmark.iconMediaType]);

    if (bookmark.iconMediaType && source) {
        if (bookmark.iconMediaType.startsWith("video/")) {
            return (
                <video
                    className={className ?? "vc-ps-bm-media"}
                    src={source}
                    muted
                    loop
                    playsInline
                    autoPlay={alwaysAnimate}
                    onMouseEnter={e => {
                        if (!alwaysAnimate) void e.currentTarget.play().catch(() => {});
                    }}
                    onMouseLeave={e => {
                        if (!alwaysAnimate) e.currentTarget.pause();
                    }}
                />
            );
        }
        return <img className={className ?? "vc-ps-bm-media"} src={source} alt={bookmark.name} />;
    }

    return <span className="vc-ps-bm-emoji">{bookmark.icon}</span>;
}

function LocalFilePreview({ file, className }: { file: File; className?: string; }) {
    const [url, setUrl] = useState<string>();

    useEffect(() => {
        const objectUrl = URL.createObjectURL(file);
        setUrl(objectUrl);
        return () => URL.revokeObjectURL(objectUrl);
    }, [file]);

    if (!url) return null;
    if (file.type.startsWith("video/") || /\.(webm|mp4)$/i.test(file.name)) {
        return <video className={className ?? "vc-ps-bm-media"} src={url} muted loop playsInline autoPlay />;
    }
    return <img className={className ?? "vc-ps-bm-media"} src={url} alt={file.name} />;
}

interface PendingZipPrompt {
    zipName: string;
    zipFiles: File[];
    otherFiles: File[];
}

interface BookmarkFormState {
    mode: "create" | "edit";
    id?: string;
    name: string;
    icon: string;
    iconFile?: File | null;
    hasExistingFile?: boolean;
}

export interface StickerLibraryProps {
    channelId?: string;
    onClose(): void;
}

export function StickerLibrary({ channelId, onClose }: StickerLibraryProps) {
    const { alwaysAnimate } = settings.use(["alwaysAnimate"]);
    const [stickers, setStickers] = useState<PersonalSticker[]>([]);
    const [bookmarks, setBookmarks] = useState<StickerBookmark[]>([]);
    const [query, setQuery] = useState("");
    const [busy, setBusy] = useState(true);
    const [status, setStatus] = useState("");
    const [error, setError] = useState("");
    const [showLinkForm, setShowLinkForm] = useState(false);
    const [link, setLink] = useState("");
    const [linkName, setLinkName] = useState("");
    const [editingSticker, setEditingSticker] = useState<PersonalSticker>();
    const [editName, setEditName] = useState("");
    const [hoveredSticker, setHoveredSticker] = useState<PersonalSticker>();
    const [collapsedSections, setCollapsedSections] = useState<Record<string, boolean>>({});
    const [bookmarkForm, setBookmarkForm] = useState<BookmarkFormState>();
    const [pendingZip, setPendingZip] = useState<PendingZipPrompt>();
    const [zipBookmarkName, setZipBookmarkName] = useState("");
    const [zipBookmarkIcon, setZipBookmarkIcon] = useState("📦");
    const [zipBookmarkIconFile, setZipBookmarkIconFile] = useState<File>();
    const [targetBookmarkUploadId, setTargetBookmarkUploadId] = useState<string>();

    const fileInput = useRef<HTMLInputElement>(null);
    const bookmarkFileInput = useRef<HTMLInputElement>(null);
    const bmIconInput = useRef<HTMLInputElement>(null);
    const zipIconInput = useRef<HTMLInputElement>(null);
    const sectionRefs = useRef<Record<string, HTMLDivElement | null>>({});
    const operationRunning = useRef(false);
    const conversionController = useRef<AbortController | null>(null);

    async function refreshAll() {
        const [loadedStickers, loadedBookmarks] = await Promise.all([listStickers(), listBookmarks()]);
        setStickers(loadedStickers);
        setBookmarks(loadedBookmarks);
    }

    useEffect(() => {
        let disposed = false;
        Promise.all([listStickers(), listBookmarks()]).then(([loadedStickers, loadedBookmarks]) => {
            if (!disposed) {
                setStickers(loadedStickers);
                setBookmarks(loadedBookmarks);
            }
        }).catch(err => {
            if (!disposed) {
                setError(errorMessage(err));
            }
        }).finally(() => {
            if (!disposed) {
                setBusy(false);
            }
        });

        return () => {
            disposed = true;
            conversionController.current?.abort();
        };
    }, []);

    async function runOperation(operation: () => Promise<void>) {
        if (operationRunning.current) {
            return;
        }
        operationRunning.current = true;
        setBusy(true);
        setError("");
        setStatus("");

        try {
            await operation();
        } catch (err) {
            setError(errorMessage(err));
        } finally {
            try {
                await refreshAll();
            } catch (err) {
                setError(errorMessage(err));
            }
            setBusy(false);
            operationRunning.current = false;
        }
    }

    async function importBatch(files: File[], targetBookmarkId?: string) {
        await runOperation(async () => {
            const expanded: File[] = [];
            const rejected: string[] = [];

            for (const file of files) {
                if (file.name.toLowerCase().endsWith(".zip")) {
                    try {
                        setStatus(`Extracting ${file.name}…`);
                        const extracted = await extractZipStickers(file);
                        if (!extracted.length) {
                            rejected.push(`No supported stickers found in ${file.name}`);
                        } else {
                            expanded.push(...extracted);
                        }
                    } catch (err) {
                        rejected.push(`${file.name}: ${errorMessage(err)}`);
                    }
                } else {
                    expanded.push(file);
                }
            }

            let imported = 0;
            for (const file of expanded) {
                try {
                    await importSticker(file, targetBookmarkId);
                    imported++;
                    setStatus(`Importing ${imported} / ${expanded.length}…`);
                } catch (err) {
                    if (err instanceof DOMException && err.name === "QuotaExceededError") {
                        throw err;
                    }
                    rejected.push(errorMessage(err));
                }
            }

            setQuery("");
            setStatus(imported ? `Imported ${imported} sticker${imported === 1 ? "" : "s"}.` : "");
            if (rejected.length) {
                setError(`${rejected.length} item(s) skipped. ${rejected[0]}`);
            }

            void navigator.storage?.persist?.().catch(() => {});
        });
    }

    function handleSelectedFiles(files: File[], forcedBookmarkId?: string) {
        if (!files.length) return;

        if (forcedBookmarkId) {
            void importBatch(files, forcedBookmarkId);
            return;
        }

        const zipFiles = files.filter(f => f.name.toLowerCase().endsWith(".zip"));
        const otherFiles = files.filter(f => !f.name.toLowerCase().endsWith(".zip"));

        if (zipFiles.length > 0) {
            const defaultName = zipFiles[0].name.replace(/\.zip$/i, "");
            setZipBookmarkName(defaultName);
            setZipBookmarkIcon("📦");
            setZipBookmarkIconFile(undefined);
            setPendingZip({
                zipName: zipFiles.map(z => z.name).join(", "),
                zipFiles,
                otherFiles
            });
            return;
        }

        void importBatch(files);
    }

    async function confirmZipImport(createNewBookmark: boolean) {
        if (!pendingZip) return;
        const { zipFiles, otherFiles } = pendingZip;
        setPendingZip(undefined);

        await runOperation(async () => {
            let bookmarkId: string | undefined;
            if (createNewBookmark) {
                const created = await createBookmark(zipBookmarkName || "Pack", zipBookmarkIcon || "📦", zipBookmarkIconFile);
                bookmarkId = created.id;
            }

            const rejected: string[] = [];
            const zipExtracted: File[] = [];

            for (const zf of zipFiles) {
                try {
                    setStatus(`Extracting ${zf.name}…`);
                    const extracted = await extractZipStickers(zf);
                    if (!extracted.length) {
                        rejected.push(`No supported stickers found in ${zf.name}`);
                    } else {
                        zipExtracted.push(...extracted);
                    }
                } catch (err) {
                    rejected.push(`${zf.name}: ${errorMessage(err)}`);
                }
            }

            let imported = 0;
            const total = zipExtracted.length + otherFiles.length;

            for (const file of zipExtracted) {
                try {
                    await importSticker(file, bookmarkId);
                    imported++;
                    setStatus(`Importing ${imported} / ${total}…`);
                } catch (err) {
                    if (err instanceof DOMException && err.name === "QuotaExceededError") {
                        throw err;
                    }
                    rejected.push(errorMessage(err));
                }
            }

            for (const file of otherFiles) {
                try {
                    await importSticker(file);
                    imported++;
                    setStatus(`Importing ${imported} / ${total}…`);
                } catch (err) {
                    if (err instanceof DOMException && err.name === "QuotaExceededError") {
                        throw err;
                    }
                    rejected.push(errorMessage(err));
                }
            }

            setQuery("");
            setStatus(imported ? `Imported ${imported} sticker${imported === 1 ? "" : "s"}.` : "");
            if (rejected.length) {
                setError(`${rejected.length} item(s) skipped. ${rejected[0]}`);
            }

            void navigator.storage?.persist?.().catch(() => {});
        });
    }

    async function useSticker(sticker: PersonalSticker) {
        await runOperation(async () => {
            const targetId = channelId ?? SelectedChannelStore.getChannelId();
            const channel = targetId ? ChannelStore.getChannel(targetId) : undefined;
            if (!channel) {
                throw new Error("Open a chat before using a sticker.");
            }
            if (SelectedChannelStore.getChannelId() !== targetId) {
                throw new Error("Selected chat changed. Reopen the picker.");
            }

            const controller = new AbortController();
            conversionController.current = controller;
            let gif = await getCachedGif(sticker.id);

            if (!gif) {
                setStatus("Preparing GIF…");
                let blob: Blob | undefined;
                if (sticker.url) {
                    try {
                        const response = await fetch(sticker.url, { signal: controller.signal });
                        if (!response.ok) {
                            throw new Error(`HTTP ${response.status}`);
                        }
                        blob = await response.blob();
                    } catch (err) {
                        controller.signal.throwIfAborted();
                        throw new Error(`Could not download sticker (${errorMessage(err)}).`);
                    }
                } else {
                    blob = await getStickerFile(sticker.id);
                }
                if (!blob) {
                    throw new Error("Sticker file missing. Import it again.");
                }

                gif = await convertToStickerGif(
                    blob.slice(0, blob.size, sticker.mediaType),
                    sticker.fileName,
                    progress => setStatus(`Converting to GIF… ${progress}%`),
                    controller.signal
                );
                controller.signal.throwIfAborted();
                await cacheStickerGif(sticker.id, gif).catch(() => {});
            }

            controller.signal.throwIfAborted();
            if (SelectedChannelStore.getChannelId() !== targetId) {
                throw new Error("Selected chat changed. Reopen the picker.");
            }
            const file = new File([gif], sticker.fileName.replace(/\.[^.]+$/, "") + ".gif", { type: "image/gif" });
            UploadHandler.promptToUpload([file], channel, DraftType.ChannelMessage);
            onClose();
        });
    }

    function openStickerContextMenu(event: React.MouseEvent, sticker: PersonalSticker) {
        event.preventDefault();
        event.stopPropagation();

        ContextMenuApi.openContextMenu(event, () => (
            <Menu.Menu navId="vc-ps-sticker-menu" onClose={ContextMenuApi.closeContextMenu} aria-label="Sticker Actions">
                <Menu.MenuItem
                    id="vc-ps-favorite"
                    label={sticker.favorite ? "Remove from Favorites" : "Add to Favorites"}
                    icon={sticker.favorite ? StarFilled : StarOutlined}
                    action={() => void runOperation(() => toggleFavoriteSticker(sticker.id))}
                />
                <Menu.MenuItem
                    id="vc-ps-bookmark-move"
                    label="Move to Bookmark"
                >
                    <Menu.MenuItem
                        id="vc-ps-bookmark-none"
                        label="Uncategorized (Personal Stickers)"
                        disabled={!sticker.bookmarkId}
                        action={() => void runOperation(() => setStickerBookmark(sticker.id, undefined))}
                    />
                    {bookmarks.length > 0 && <Menu.MenuSeparator />}
                    {bookmarks.map(bm => (
                        <Menu.MenuItem
                            key={bm.id}
                            id={`vc-ps-bm-${bm.id}`}
                            label={`${bm.iconMediaType ? "🖼️" : bm.icon} ${bm.name}`}
                            disabled={sticker.bookmarkId === bm.id}
                            action={() => void runOperation(() => setStickerBookmark(sticker.id, bm.id))}
                        />
                    ))}
                    <Menu.MenuSeparator />
                    <Menu.MenuItem
                        id="vc-ps-bm-create-from-sticker"
                        label="+ New Bookmark…"
                        action={() => {
                            setBookmarkForm({ mode: "create", name: "", icon: "📁" });
                        }}
                    />
                </Menu.MenuItem>
                <Menu.MenuItem
                    id="vc-ps-rename"
                    label="Rename Sticker"
                    icon={PencilIcon}
                    action={() => {
                        setEditingSticker(sticker);
                        setEditName(sticker.name);
                    }}
                />
                <Menu.MenuSeparator />
                <Menu.MenuItem
                    id="vc-ps-delete"
                    label="Delete Sticker"
                    color="danger"
                    icon={DeleteIcon}
                    action={() => void runOperation(async () => {
                        await removeSticker(sticker.id);
                        if (hoveredSticker?.id === sticker.id) setHoveredSticker(undefined);
                        if (editingSticker?.id === sticker.id) setEditingSticker(undefined);
                    })}
                />
            </Menu.Menu>
        ));
    }

    function openBookmarkContextMenu(event: React.MouseEvent, bm: StickerBookmark, index: number) {
        event.preventDefault();
        event.stopPropagation();

        ContextMenuApi.openContextMenu(event, () => (
            <Menu.Menu navId="vc-ps-bookmark-menu" onClose={ContextMenuApi.closeContextMenu} aria-label="Bookmark Actions">
                <Menu.MenuItem
                    id="vc-ps-bm-upload"
                    label="Import Files / .ZIP Here"
                    icon={FolderIcon}
                    action={() => {
                        setTargetBookmarkUploadId(bm.id);
                        setTimeout(() => bookmarkFileInput.current?.click(), 0);
                    }}
                />
                <Menu.MenuItem
                    id="vc-ps-bm-edit"
                    label="Edit Bookmark (Name & Icon)"
                    icon={PencilIcon}
                    action={() => {
                        setBookmarkForm({
                            mode: "edit",
                            id: bm.id,
                            name: bm.name,
                            icon: bm.icon,
                            iconFile: undefined,
                            hasExistingFile: !!bm.iconMediaType
                        });
                    }}
                />
                <Menu.MenuSeparator />
                <Menu.MenuItem
                    id="vc-ps-bm-up"
                    label="Move Up"
                    icon={UpArrowIcon}
                    disabled={index === 0}
                    action={() => void runOperation(() => moveBookmark(bm.id, -1))}
                />
                <Menu.MenuItem
                    id="vc-ps-bm-down"
                    label="Move Down"
                    icon={DownArrow}
                    disabled={index === bookmarks.length - 1}
                    action={() => void runOperation(() => moveBookmark(bm.id, 1))}
                />
                <Menu.MenuSeparator />
                <Menu.MenuItem
                    id="vc-ps-bm-delete-keep"
                    label="Delete Bookmark (Keep Stickers)"
                    color="danger"
                    icon={DeleteIcon}
                    action={() => void runOperation(() => deleteBookmark(bm.id, false))}
                />
                <Menu.MenuItem
                    id="vc-ps-bm-delete-all"
                    label="Delete Bookmark & All Stickers"
                    color="danger"
                    icon={DeleteIcon}
                    action={() => void runOperation(() => deleteBookmark(bm.id, true))}
                />
            </Menu.Menu>
        ));
    }

    function toggleSection(key: string) {
        setCollapsedSections(prev => ({ ...prev, [key]: !prev[key] }));
    }

    function scrollToSection(key: string) {
        setCollapsedSections(prev => ({ ...prev, [key]: false }));
        setTimeout(() => {
            sectionRefs.current[key]?.scrollIntoView({ behavior: "smooth", block: "start" });
        }, 20);
    }

    function renderStickerItem(sticker: PersonalSticker) {
        return (
            <div
                className="vc-ps-item"
                key={sticker.id}
                onMouseEnter={() => setHoveredSticker(sticker)}
                onMouseLeave={() => setHoveredSticker(current => current?.id === sticker.id ? undefined : current)}
                onContextMenu={e => openStickerContextMenu(e, sticker)}
            >
                <button
                    type="button"
                    className="vc-ps-sticker"
                    aria-label={sticker.name}
                    disabled={busy}
                    onClick={() => void useSticker(sticker)}
                    onFocus={event => {
                        setHoveredSticker(sticker);
                        if (!alwaysAnimate) {
                            void event.currentTarget.querySelector("video")?.play().catch(() => {});
                        }
                    }}
                    onBlur={event => {
                        if (!alwaysAnimate) {
                            event.currentTarget.querySelector("video")?.pause();
                        }
                    }}
                >
                    <StickerPreview sticker={sticker} alwaysAnimate={alwaysAnimate} />
                </button>
                <button
                    type="button"
                    className={`vc-ps-fav-btn ${sticker.favorite ? "is-fav" : ""}`}
                    title={sticker.favorite ? "Unfavorite" : "Favorite"}
                    aria-label={sticker.favorite ? "Unfavorite" : "Favorite"}
                    disabled={busy}
                    onClick={e => {
                        e.stopPropagation();
                        void runOperation(() => toggleFavoriteSticker(sticker.id));
                    }}
                >
                    {sticker.favorite ? <StarFilled width={14} height={14} /> : <StarOutlined width={14} height={14} />}
                </button>
            </div>
        );
    }

    const search = query.trim().toLocaleLowerCase();
    const filtered = stickers.filter(sticker => sticker.name.toLocaleLowerCase().includes(search));
    const favorites = filtered.filter(sticker => sticker.favorite);
    const validBookmarkIds = new Set(bookmarks.map(b => b.id));
    const uncategorized = filtered.filter(sticker => !sticker.bookmarkId || !validBookmarkIds.has(sticker.bookmarkId));

    return (
        <div className="vc-ps-popout" onClick={e => e.stopPropagation()}>
            <div className="vc-ps-header">
                <div className="vc-ps-search-wrap">
                    <SearchIcon width={16} height={16} className="vc-ps-search-icon" />
                    <input
                        className="vc-ps-search-input"
                        aria-label="Search personal stickers"
                        placeholder={hoveredSticker ? hoveredSticker.name : "Find the perfect sticker"}
                        value={query}
                        onChange={event => setQuery(event.currentTarget.value)}
                    />
                </div>
                <Tooltip text="Import files or .zip" position="top">
                    {tooltipProps => (
                        <button
                            {...tooltipProps}
                            type="button"
                            className="vc-ps-icon-btn"
                            aria-label="Import files or .zip"
                            disabled={busy}
                            onClick={() => fileInput.current?.click()}
                        >
                            <FolderIcon width={18} height={18} />
                        </button>
                    )}
                </Tooltip>
                <Tooltip text="Add sticker from URL" position="top">
                    {tooltipProps => (
                        <button
                            {...tooltipProps}
                            type="button"
                            className={`vc-ps-icon-btn ${showLinkForm ? "is-active" : ""}`}
                            aria-label="Add sticker from URL"
                            disabled={busy}
                            onClick={() => setShowLinkForm(!showLinkForm)}
                        >
                            <LinkIcon width={18} height={18} />
                        </button>
                    )}
                </Tooltip>
                <input
                    ref={fileInput}
                    type="file"
                    accept={acceptedFiles}
                    multiple
                    hidden
                    onChange={event => {
                        const files = Array.from(event.currentTarget.files ?? []);
                        event.currentTarget.value = "";
                        handleSelectedFiles(files);
                    }}
                />
                <input
                    ref={bookmarkFileInput}
                    type="file"
                    accept={acceptedFiles}
                    multiple
                    hidden
                    onChange={event => {
                        const files = Array.from(event.currentTarget.files ?? []);
                        const targetId = targetBookmarkUploadId;
                        event.currentTarget.value = "";
                        setTargetBookmarkUploadId(undefined);
                        if (files.length && targetId) {
                            handleSelectedFiles(files, targetId);
                        }
                    }}
                />
                <input
                    ref={bmIconInput}
                    type="file"
                    accept={acceptedIconFiles}
                    hidden
                    onChange={event => {
                        const file = event.currentTarget.files?.[0];
                        event.currentTarget.value = "";
                        if (file && bookmarkForm) {
                            setBookmarkForm({ ...bookmarkForm, iconFile: file });
                        }
                    }}
                />
                <input
                    ref={zipIconInput}
                    type="file"
                    accept={acceptedIconFiles}
                    hidden
                    onChange={event => {
                        const file = event.currentTarget.files?.[0];
                        event.currentTarget.value = "";
                        if (file) {
                            setZipBookmarkIconFile(file);
                        }
                    }}
                />
            </div>

            {pendingZip && (
                <div className="vc-ps-dialog-bar">
                    <div className="vc-ps-dialog-title">
                        Create a bookmark for <strong>{pendingZip.zipName}</strong>?
                    </div>
                    <div className="vc-ps-dialog-row">
                        {zipBookmarkIconFile ? (
                            <div className="vc-ps-custom-icon-chip" title={zipBookmarkIconFile.name}>
                                <LocalFilePreview file={zipBookmarkIconFile} />
                            </div>
                        ) : (
                            <input
                                className="vc-ps-input vc-ps-icon-input"
                                aria-label="Bookmark icon"
                                value={zipBookmarkIcon}
                                onChange={e => setZipBookmarkIcon(e.currentTarget.value)}
                                maxLength={4}
                            />
                        )}
                        <button
                            type="button"
                            className="vc-ps-icon-btn"
                            title="Upload custom icon (.png, .ico, .jpg, .gif, .webm…)"
                            onClick={() => zipIconInput.current?.click()}
                        >
                            <ImageIcon width={16} height={16} />
                        </button>
                        <input
                            className="vc-ps-input"
                            aria-label="Bookmark name"
                            placeholder="Bookmark name"
                            value={zipBookmarkName}
                            onChange={e => setZipBookmarkName(e.currentTarget.value)}
                        />
                    </div>
                    <div className="vc-ps-icon-presets">
                        {BOOKMARK_ICONS.map(ic => (
                            <button
                                key={ic}
                                type="button"
                                className={`vc-ps-preset-btn ${!zipBookmarkIconFile && zipBookmarkIcon === ic ? "is-selected" : ""}`}
                                onClick={() => {
                                    setZipBookmarkIconFile(undefined);
                                    setZipBookmarkIcon(ic);
                                }}
                            >
                                {ic}
                            </button>
                        ))}
                    </div>
                    <div className="vc-ps-dialog-actions">
                        <Button size="xs" disabled={busy} onClick={() => void confirmZipImport(true)}>
                            Create & Import
                        </Button>
                        <Button size="xs" variant="secondary" disabled={busy} onClick={() => void confirmZipImport(false)}>
                            Import Without Bookmark
                        </Button>
                        <Button size="xs" variant="dangerSecondary" disabled={busy} onClick={() => setPendingZip(undefined)}>
                            Cancel
                        </Button>
                    </div>
                </div>
            )}

            {bookmarkForm && (
                <form
                    className="vc-ps-dialog-bar"
                    onSubmit={event => {
                        event.preventDefault();
                        void runOperation(async () => {
                            if (bookmarkForm.mode === "create") {
                                await createBookmark(
                                    bookmarkForm.name,
                                    bookmarkForm.icon,
                                    bookmarkForm.iconFile ?? undefined
                                );
                            } else if (bookmarkForm.id) {
                                await updateBookmark(
                                    bookmarkForm.id,
                                    bookmarkForm.name,
                                    bookmarkForm.icon,
                                    bookmarkForm.iconFile
                                );
                            }
                            setBookmarkForm(undefined);
                        });
                    }}
                >
                    <div className="vc-ps-dialog-title">
                        {bookmarkForm.mode === "create" ? "New Bookmark" : "Edit Bookmark"}
                    </div>
                    <div className="vc-ps-dialog-row">
                        {bookmarkForm.iconFile ? (
                            <div className="vc-ps-custom-icon-chip" title={bookmarkForm.iconFile.name}>
                                <LocalFilePreview file={bookmarkForm.iconFile} />
                            </div>
                        ) : (bookmarkForm.hasExistingFile && bookmarkForm.iconFile === undefined && bookmarkForm.id) ? (
                            <div className="vc-ps-custom-icon-chip" title="Current custom icon">
                                <BookmarkIconView
                                    bookmark={{
                                        id: bookmarkForm.id,
                                        name: bookmarkForm.name,
                                        icon: bookmarkForm.icon,
                                        iconMediaType: bookmarks.find(b => b.id === bookmarkForm.id)?.iconMediaType
                                    }}
                                    alwaysAnimate={alwaysAnimate}
                                />
                            </div>
                        ) : (
                            <input
                                className="vc-ps-input vc-ps-icon-input"
                                aria-label="Bookmark icon"
                                value={bookmarkForm.icon}
                                onChange={e => setBookmarkForm({ ...bookmarkForm, icon: e.currentTarget.value, iconFile: null })}
                                maxLength={4}
                            />
                        )}
                        <button
                            type="button"
                            className="vc-ps-icon-btn"
                            title="Upload custom icon (.png, .ico, .jpg, .gif, .webm…)"
                            onClick={() => bmIconInput.current?.click()}
                        >
                            <ImageIcon width={16} height={16} />
                        </button>
                        <input
                            className="vc-ps-input"
                            aria-label="Bookmark name"
                            placeholder="Bookmark name"
                            required
                            autoFocus
                            value={bookmarkForm.name}
                            onChange={e => setBookmarkForm({ ...bookmarkForm, name: e.currentTarget.value })}
                        />
                    </div>
                    <div className="vc-ps-icon-presets">
                        {BOOKMARK_ICONS.map(ic => (
                            <button
                                key={ic}
                                type="button"
                                className={`vc-ps-preset-btn ${!bookmarkForm.iconFile && !(bookmarkForm.hasExistingFile && bookmarkForm.iconFile === undefined) && bookmarkForm.icon === ic ? "is-selected" : ""}`}
                                onClick={() => setBookmarkForm({ ...bookmarkForm, icon: ic, iconFile: null, hasExistingFile: false })}
                            >
                                {ic}
                            </button>
                        ))}
                    </div>
                    <div className="vc-ps-dialog-actions">
                        <Button type="submit" size="xs" disabled={busy}>
                            {bookmarkForm.mode === "create" ? "Create" : "Save"}
                        </Button>
                        <Button size="xs" variant="secondary" disabled={busy} onClick={() => setBookmarkForm(undefined)}>
                            Cancel
                        </Button>
                    </div>
                </form>
            )}

            {showLinkForm && (
                <form
                    className="vc-ps-inline-bar"
                    onSubmit={event => {
                        event.preventDefault();
                        void runOperation(async () => {
                            await addLinkedSticker(link, linkName);
                            setLink("");
                            setLinkName("");
                            setShowLinkForm(false);
                            setQuery("");
                        });
                    }}
                >
                    <input
                        className="vc-ps-input"
                        type="url"
                        required
                        placeholder="https://example.com/sticker.webm"
                        value={link}
                        onChange={event => setLink(event.currentTarget.value)}
                    />
                    <input
                        className="vc-ps-input vc-ps-input-sm"
                        placeholder="Name (opt)"
                        value={linkName}
                        onChange={event => setLinkName(event.currentTarget.value)}
                    />
                    <Button type="submit" size="xs" disabled={busy}>Add</Button>
                </form>
            )}

            {editingSticker && (
                <form
                    className="vc-ps-inline-bar"
                    onSubmit={event => {
                        event.preventDefault();
                        void runOperation(async () => {
                            await renameSticker(editingSticker.id, editName);
                            setEditingSticker(undefined);
                        });
                    }}
                >
                    <span className="vc-ps-inline-label">Rename:</span>
                    <input
                        className="vc-ps-input"
                        value={editName}
                        autoFocus
                        onChange={event => setEditName(event.currentTarget.value)}
                    />
                    <Button type="submit" size="xs" disabled={busy}>Save</Button>
                    <Button size="xs" variant="secondary" disabled={busy} onClick={() => setEditingSticker(undefined)}>Cancel</Button>
                </form>
            )}

            {error && <div className="vc-ps-error" role="alert">{error}</div>}
            {status && <div className="vc-ps-status" role="status">{status}</div>}

            <div className="vc-ps-body">
                <div className="vc-ps-sidebar-wrap">
                    <ScrollerThin className="vc-ps-sidebar" fade>
                        <Tooltip text="Favorites" position="right">
                            {tooltipProps => (
                                <button
                                    {...tooltipProps}
                                    type="button"
                                    className="vc-ps-nav-btn"
                                    onClick={() => scrollToSection("favorites")}
                                >
                                    <StarFilled width={18} height={18} />
                                </button>
                            )}
                        </Tooltip>

                        {bookmarks.map((bm, index) => (
                            <Tooltip key={bm.id} text={bm.name} position="right">
                                {tooltipProps => (
                                    <button
                                        {...tooltipProps}
                                        type="button"
                                        className="vc-ps-nav-btn vc-ps-nav-bookmark"
                                        onClick={() => scrollToSection(`bm:${bm.id}`)}
                                        onContextMenu={e => openBookmarkContextMenu(e, bm, index)}
                                    >
                                        <BookmarkIconView bookmark={bm} alwaysAnimate={alwaysAnimate} />
                                    </button>
                                )}
                            </Tooltip>
                        ))}

                        <Tooltip text="Personal Stickers" position="right">
                            {tooltipProps => (
                                <button
                                    {...tooltipProps}
                                    type="button"
                                    className="vc-ps-nav-btn"
                                    onClick={() => scrollToSection("uncategorized")}
                                >
                                    <FolderIcon width={18} height={18} />
                                </button>
                            )}
                        </Tooltip>

                        <div className="vc-ps-sidebar-divider" />

                        <Tooltip text="Create Bookmark" position="right">
                            {tooltipProps => (
                                <button
                                    {...tooltipProps}
                                    type="button"
                                    className="vc-ps-nav-btn vc-ps-nav-add"
                                    onClick={() => setBookmarkForm({ mode: "create", name: "", icon: "📁" })}
                                >
                                    <PlusIcon width={16} height={16} />
                                </button>
                            )}
                        </Tooltip>
                    </ScrollerThin>
                </div>

                <ScrollerThin className="vc-ps-scroller" fade>
                    {favorites.length > 0 && (
                        <div
                            className="vc-ps-section"
                            ref={el => { sectionRefs.current.favorites = el; }}
                        >
                            <button
                                type="button"
                                className="vc-ps-section-header"
                                onClick={() => toggleSection("favorites")}
                            >
                                <StarFilled width={14} height={14} />
                                <span>Favorites ({favorites.length})</span>
                                {collapsedSections.favorites ? <RightArrow width={14} height={14} /> : <DownArrow width={14} height={14} />}
                            </button>
                            {!collapsedSections.favorites && (
                                <div className="vc-ps-grid">
                                    {favorites.map(renderStickerItem)}
                                </div>
                            )}
                        </div>
                    )}

                    {bookmarks.map((bm, index) => {
                        const bmStickers = filtered.filter(s => s.bookmarkId === bm.id);
                        if (search && bmStickers.length === 0) return null;
                        const sectionKey = `bm:${bm.id}`;
                        const isCollapsed = !!collapsedSections[sectionKey];

                        return (
                            <div
                                className="vc-ps-section"
                                key={bm.id}
                                ref={el => { sectionRefs.current[sectionKey] = el; }}
                            >
                                <div
                                    className="vc-ps-section-header-row"
                                    onContextMenu={e => openBookmarkContextMenu(e, bm, index)}
                                >
                                    <button
                                        type="button"
                                        className="vc-ps-section-header"
                                        onClick={() => toggleSection(sectionKey)}
                                    >
                                        <span className="vc-ps-section-icon-wrap">
                                            <BookmarkIconView
                                                bookmark={bm}
                                                alwaysAnimate={alwaysAnimate}
                                                className="vc-ps-section-media"
                                            />
                                        </span>
                                        <span>{bm.name} ({bmStickers.length})</span>
                                        {isCollapsed ? <RightArrow width={14} height={14} /> : <DownArrow width={14} height={14} />}
                                    </button>
                                    <Tooltip text={`Import into ${bm.name}`} position="left">
                                        {tooltipProps => (
                                            <button
                                                {...tooltipProps}
                                                type="button"
                                                className="vc-ps-section-action"
                                                onClick={() => {
                                                    setTargetBookmarkUploadId(bm.id);
                                                    setTimeout(() => bookmarkFileInput.current?.click(), 0);
                                                }}
                                            >
                                                <PlusIcon width={14} height={14} />
                                            </button>
                                        )}
                                    </Tooltip>
                                </div>
                                {!isCollapsed && (
                                    bmStickers.length > 0 ? (
                                        <div className="vc-ps-grid">
                                            {bmStickers.map(renderStickerItem)}
                                        </div>
                                    ) : (
                                        <div className="vc-ps-empty-bm">
                                            <span>Empty bookmark.</span>
                                            <button
                                                type="button"
                                                className="vc-ps-link-btn"
                                                onClick={() => {
                                                    setTargetBookmarkUploadId(bm.id);
                                                    setTimeout(() => bookmarkFileInput.current?.click(), 0);
                                                }}
                                            >
                                                Import files or .zip
                                            </button>
                                        </div>
                                    )
                                )}
                            </div>
                        );
                    })}

                    {(uncategorized.length > 0 || bookmarks.length === 0) && (
                        <div
                            className="vc-ps-section"
                            ref={el => { sectionRefs.current.uncategorized = el; }}
                        >
                            <button
                                type="button"
                                className="vc-ps-section-header"
                                onClick={() => toggleSection("uncategorized")}
                            >
                                <FolderIcon width={14} height={14} />
                                <span>{search ? `Other Results (${uncategorized.length})` : `Personal Stickers (${uncategorized.length})`}</span>
                                {collapsedSections.uncategorized ? <RightArrow width={14} height={14} /> : <DownArrow width={14} height={14} />}
                            </button>
                            {!collapsedSections.uncategorized && (
                                <div className="vc-ps-grid">
                                    {uncategorized.map(renderStickerItem)}
                                </div>
                            )}
                        </div>
                    )}

                    {!busy && !filtered.length && (
                        <div className="vc-ps-empty">
                            <p>{stickers.length ? "No matching stickers." : "Your sticker library is empty."}</p>
                            {!stickers.length && (
                                <Button size="small" onClick={() => fileInput.current?.click()}>
                                    Import files or .zip
                                </Button>
                            )}
                        </div>
                    )}
                </ScrollerThin>
            </div>

            <div className="vc-ps-footer">
                {hoveredSticker ? (
                    <div className="vc-ps-footer-info">
                        <span className="vc-ps-footer-name">{hoveredSticker.name}</span>
                        <span className="vc-ps-footer-meta">
                            {hoveredSticker.url ? "URL" : `${Math.max(1, Math.round(hoveredSticker.size / 1024))} KB`}
                            {" · "}
                            {hoveredSticker.fileName.split(".").pop()?.toUpperCase()}
                        </span>
                    </div>
                ) : (
                    <span className="vc-ps-footer-hint">
                        {stickers.length} sticker{stickers.length === 1 ? "" : "s"} · Right-click for options
                    </span>
                )}
            </div>
        </div>
    );
}

interface PickerProps extends RenderModalProps {
    channelId?: string;
}

export function StickerPicker({ channelId, ...props }: PickerProps) {
    return (
        <Modal {...props} title="Personal Stickers" size="md">
            <StickerLibrary channelId={channelId} onClose={props.onClose} />
        </Modal>
    );
}
