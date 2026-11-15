/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./styles.css";

import { ChatBarButton, ChatBarButtonFactory } from "@api/ChatButtons";
import { findGroupChildrenByChildId, NavContextMenuPatchCallback } from "@api/ContextMenu";
import { definePluginSettings } from "@api/Settings";
import { Button } from "@components/Button";
import { FolderIcon } from "@components/Icons";
import { Paragraph } from "@components/Paragraph";
import definePlugin, { IconComponent, OptionType } from "@utils/types";
import { Message, StickerItem } from "@vencord/discord-types";
import { StickerFormatType } from "@vencord/discord-types/enums";
import { closeModal, Menu, openModal, Popout, showToast, useRef } from "@webpack/common";

import { StickerLibrary, StickerPicker } from "./StickerPicker";
import { getCachedBookmarks, importStickerFromUrl, listBookmarks } from "./storage";

export const settings = definePluginSettings({
    alwaysAnimate: {
        type: OptionType.BOOLEAN,
        description: "Play animated/video stickers continuously in the picker instead of only on hover",
        default: true
    }
});

const StickerIcon: IconComponent = ({ width = 20, height = 20, className }) => {
    return (
        <svg width={width} height={height} className={className} viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path
                d="M14 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v9m-7 7 7-7m-7 7v-5a2 2 0 0 1 2-2h5"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
            />
            <path d="M8 8h.01M15 8h.01M8 12a5 5 0 0 0 5 1" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
    );
};

const StickerExtMap: Record<number, string> = {
    [StickerFormatType.PNG]: "png",
    [StickerFormatType.APNG]: "png",
    [StickerFormatType.GIF]: "gif"
};

function formatStickerURL(id: string, formatType: number) {
    const ext = StickerExtMap[formatType] ?? "png";
    return `${location.protocol}${window.GLOBAL_ENV.MEDIA_PROXY_ENDPOINT}/stickers/${id}.${ext}?size=320&lossless=true&animated=true`;
}

function formatEmojiURL(id: string) {
    return `${location.protocol}//${window.GLOBAL_ENV.CDN_HOST}/emojis/${id}.webp?size=160&lossless=true&animated=true`;
}

async function saveToPersonalStickers(url: string, name?: string, bookmarkId?: string, bookmarkName?: string) {
    try {
        await importStickerFromUrl(url, name, bookmarkId);
        showToast({
            text: bookmarkName ? `Added to Personal Stickers (${bookmarkName})!` : "Added to Personal Stickers!",
            variant: "success"
        });
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        showToast({
            text: `Failed to add sticker: ${msg}`,
            variant: "critical"
        });
    }
}

function buildAddToPersonalStickersMenuItem(url: string, name?: string) {
    const bookmarks = getCachedBookmarks();

    if (bookmarks.length === 0) {
        return (
            <Menu.MenuItem
                key="vc-ps-add-context"
                id="vc-ps-add-context"
                label="Add to Personal Stickers"
                icon={StickerIcon}
                leadingAccessory={{ type: "icon", icon: StickerIcon }}
                action={() => void saveToPersonalStickers(url, name)}
            />
        );
    }

    return (
        <Menu.MenuItem
            key="vc-ps-add-context"
            id="vc-ps-add-context"
            label="Add to Personal Stickers"
            icon={StickerIcon}
            leadingAccessory={{ type: "icon", icon: StickerIcon }}
            action={() => void saveToPersonalStickers(url, name)}
        >
            <Menu.MenuItem
                key="vc-ps-add-uncategorized"
                id="vc-ps-add-uncategorized"
                label="Personal Stickers (Default)"
                icon={FolderIcon}
                action={() => void saveToPersonalStickers(url, name)}
            />
            <Menu.MenuSeparator key="vc-ps-add-sep" />
            {bookmarks.map(bm => (
                <Menu.MenuItem
                    key={bm.id}
                    id={`vc-ps-add-bm-${bm.id}`}
                    label={`${bm.iconMediaType ? "🖼️" : bm.icon} ${bm.name}`}
                    action={() => void saveToPersonalStickers(url, name, bm.id, bm.name)}
                />
            ))}
        </Menu.MenuItem>
    );
}

function extractMessageMediaTarget(props: any): { url: string; name?: string; } | null {
    const { favoriteableId, favoriteableType, itemHref, itemSrc, mediaItem } = props ?? {};
    const message: Message | undefined = props?.message?.messageSnapshots?.[0]?.message ?? props?.message;

    if (favoriteableType === "sticker" && favoriteableId) {
        const sticker: StickerItem | undefined = message?.stickerItems?.find((s: StickerItem) => s.id === favoriteableId);
        if (sticker && sticker.format_type !== StickerFormatType.LOTTIE) {
            return {
                url: formatStickerURL(sticker.id, sticker.format_type),
                name: sticker.name
            };
        }
    }

    if (favoriteableType === "emoji" && favoriteableId) {
        return {
            url: formatEmojiURL(favoriteableId),
            name: "emoji"
        };
    }

    if (mediaItem?.url) {
        return { url: mediaItem.url };
    }

    const src = itemSrc || itemHref;
    if (typeof src === "string" && /^https?:\/\//i.test(src)) {
        const isLikelyMedia =
            favoriteableType === "gif" ||
            /\.(gif|webm|mp4|png|apng|webp|jpe?g|avif)(\?|$)/i.test(src) ||
            src.includes("discordapp.net/attachments/") ||
            src.includes("cdn.discordapp.com/attachments/") ||
            src.includes("tenor.com") ||
            src.includes("giphy.com") ||
            src.includes("klipy.com");

        if (isLikelyMedia) {
            return { url: itemSrc || itemHref };
        }
    }

    if (message?.stickerItems?.length) {
        const sticker = message.stickerItems.find(s => s.format_type !== StickerFormatType.LOTTIE);
        if (sticker) {
            return {
                url: formatStickerURL(sticker.id, sticker.format_type),
                name: sticker.name
            };
        }
    }

    return null;
}

const messageContextMenuPatch: NavContextMenuPatchCallback = (children, props) => {
    const target = extractMessageMediaTarget(props);
    if (!target) return;

    const item = buildAddToPersonalStickersMenuItem(target.url, target.name);
    const group =
        findGroupChildrenByChildId("favorite", children) ??
        findGroupChildrenByChildId("unfavorite", children) ??
        findGroupChildrenByChildId("save-image", children) ??
        findGroupChildrenByChildId("copy-link", children);

    if (group) {
        group.push(item);
    } else {
        children.push(<Menu.MenuGroup key="vc-ps-add-group">{item}</Menu.MenuGroup>);
    }
};

const imageContextMenuPatch: NavContextMenuPatchCallback = (children, props) => {
    if (!props?.src) return;

    const item = buildAddToPersonalStickersMenuItem(props.src);
    const group = findGroupChildrenByChildId("save-image", children) ?? findGroupChildrenByChildId("copy-native-link", children) ?? children;
    group.push(item);
};

const expressionPickerContextMenuPatch: NavContextMenuPatchCallback = (children, props: { target?: HTMLElement; }) => {
    const { id, name, type, formatType } = props?.target?.dataset ?? {};
    if (!id) return;

    if (type === "sticker" && !props.target?.className?.includes("lottieCanvas")) {
        const url = formatStickerURL(id, Number(formatType));
        children.push(
            <Menu.MenuGroup key="vc-ps-add-group">
                {buildAddToPersonalStickersMenuItem(url, name)}
            </Menu.MenuGroup>
        );
    } else if (type === "emoji") {
        const url = formatEmojiURL(id);
        children.push(
            <Menu.MenuGroup key="vc-ps-add-group">
                {buildAddToPersonalStickersMenuItem(url, name)}
            </Menu.MenuGroup>
        );
    }
};

function openLibrary(channelId?: string) {
    openModal(props => <StickerPicker {...props} channelId={channelId} />, { modalKey: "vc-personal-stickers" });
}

const StickerButton: ChatBarButtonFactory = ({ channel, isMainChat, type }) => {
    const buttonRef = useRef<HTMLDivElement>(null);

    if (!isMainChat || !type.attachments) {
        return null;
    }

    return (
        <Popout
            position="top"
            align="right"
            spacing={8}
            targetElementRef={buttonRef}
            renderPopout={({ closePopout }) => (
                <StickerLibrary channelId={channel.id} onClose={closePopout} />
            )}
        >
            {popoutProps => (
                <div ref={buttonRef} className="vc-ps-chatbar-wrap">
                    <ChatBarButton
                        tooltip="Personal Stickers"
                        onClick={popoutProps.onClick}
                        buttonProps={{
                            "aria-haspopup": "dialog",
                            "aria-expanded": popoutProps["aria-expanded"],
                            "aria-controls": popoutProps["aria-controls"]
                        }}
                    >
                        <StickerIcon />
                    </ChatBarButton>
                </div>
            )}
        </Popout>
    );
};

export default definePlugin({
    name: "PersonalStickers",
    description: "A reusable local sticker library for WebM, videos, images, and ZIP archives, with bookmarks, favorites, and a compact popout picker.",
    authors: [],
    tags: ["Chat", "Utility"],
    settings,
    chatBarButton: {
        icon: StickerIcon,
        render: StickerButton
    },
    contextMenus: {
        "message": messageContextMenuPatch,
        "image-context": imageContextMenuPatch,
        "expression-picker": expressionPickerContextMenuPatch
    },
    start() {
        void listBookmarks().catch(() => {});
    },
    stop() {
        closeModal("vc-personal-stickers");
    },
    settingsAboutComponent() {
        return (
            <>
                <Paragraph>
                    Import your own stickers or a .zip pack, organize them into custom bookmarks, and use the Personal Stickers button beside the message box.
                    Stickers, including WebM videos, are converted to small, looping GIFs up to 160 px before sending and cached locally.
                </Paragraph>
                <Button onClick={() => openLibrary()}>Open sticker library</Button>
            </>
        );
    }
});
