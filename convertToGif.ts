/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { applyPalette, GIFEncoder, quantize } from "gifenc";

export const stickerSize = 160;
const framesPerSecond = 20;

interface ImageDecoderInstance {
    tracks: {
        ready: Promise<void>;
        selectedTrack: { frameCount: number; } | null;
    };
    decode(options: { frameIndex: number; }): Promise<{ image: VideoFrame; }>;
    close(): void;
}

interface ImageDecoderConstructor {
    new(options: { data: ArrayBuffer; type: string; preferAnimation: boolean; }): ImageDecoderInstance;
    isTypeSupported(type: string): Promise<boolean>;
}

function waitForVideo(video: HTMLVideoElement, event: string, start: () => void, signal: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
        signal.throwIfAborted();

        const cleanup = () => {
            clearTimeout(timeout);
            video.removeEventListener(event, onReady);
            video.removeEventListener("error", onError);
            signal.removeEventListener("abort", onAbort);
        };
        const onReady = () => {
            cleanup();
            resolve();
        };
        const onError = () => {
            cleanup();
            reject(new Error("This video could not be decoded. Try a WebM encoded with VP8 or VP9."));
        };
        const onAbort = () => {
            cleanup();
            reject(signal.reason);
        };
        const timeout = setTimeout(() => {
            cleanup();
            reject(new Error("Video decoding timed out. Try importing the file again."));
        }, 30_000);

        video.addEventListener(event, onReady, { once: true });
        video.addEventListener("error", onError, { once: true });
        signal.addEventListener("abort", onAbort, { once: true });

        try {
            start();
        } catch (error) {
            cleanup();
            reject(error);
        }
    });
}

export async function convertToStickerGif(
    blob: Blob,
    fileName: string,
    onProgress: (progress: number) => void,
    signal: AbortSignal
): Promise<File> {
    signal.throwIfAborted();
    const gif = GIFEncoder();
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) {
        throw new Error("Could not create a canvas for GIF conversion.");
    }

    function setDimensions(width: number, height: number) {
        if (width <= 0 || height <= 0) {
            throw new Error("The sticker has invalid dimensions.");
        }
        const scale = Math.min(1, stickerSize / Math.max(width, height));
        canvas.width = Math.max(1, Math.round(width * scale));
        canvas.height = Math.max(1, Math.round(height * scale));
        context!.imageSmoothingEnabled = true;
        context!.imageSmoothingQuality = "high";
    }

    function writeFrame(source: CanvasImageSource, delay: number) {
        signal.throwIfAborted();
        context!.clearRect(0, 0, canvas.width, canvas.height);
        context!.drawImage(source, 0, 0, canvas.width, canvas.height);
        const { data } = context!.getImageData(0, 0, canvas.width, canvas.height);
        const palette = quantize(data, 255);
        const indexed = applyPalette(data, palette);
        const transparentIndex = palette.length;
        palette.push([0, 0, 0]);
        let transparent = false;

        // Reserve an explicit transparent entry so opaque black stays opaque.
        for (let pixel = 0; pixel < indexed.length; pixel++) {
            if (data[pixel * 4 + 3] < 128) {
                indexed[pixel] = transparentIndex;
                transparent = true;
            }
        }

        gif.writeFrame(indexed, canvas.width, canvas.height, {
            palette,
            delay: Math.max(20, Math.round(delay / 10) * 10),
            repeat: 0,
            transparent,
            transparentIndex,
            // Clear the previous frame, including transparent moving stickers.
            dispose: 2
        });
    }

    if (blob.type.startsWith("video/")) {
        const video = document.createElement("video");
        const url = URL.createObjectURL(blob);
        video.muted = true;
        video.playsInline = true;
        video.preload = "auto";

        try {
            await waitForVideo(video, "loadeddata", () => {
                video.src = url;
            }, signal);

            // Some WebM muxers omit duration. Seeking to the end lets Chromium
            // discover it without truncating the sticker to a guessed length.
            if (!Number.isFinite(video.duration)) {
                await waitForVideo(video, "seeked", () => {
                    video.currentTime = Number.MAX_SAFE_INTEGER;
                }, signal);
            }
            const { duration } = video;
            if (!Number.isFinite(duration) || duration <= 0) {
                throw new Error("Could not determine this video's duration.");
            }

            setDimensions(video.videoWidth, video.videoHeight);
            const frameCount = Math.max(1, Math.ceil(duration * framesPerSecond));

            for (let frame = 0; frame < frameCount; frame++) {
                signal.throwIfAborted();
                const time = frame / framesPerSecond;
                if (Math.abs(video.currentTime - time) > 0.0001) {
                    await waitForVideo(video, "seeked", () => {
                        video.currentTime = time;
                    }, signal);
                }
                const delay = Math.min(1 / framesPerSecond, duration - time) * 1000;
                writeFrame(video, delay);
                onProgress(Math.round((frame + 1) / frameCount * 100));
                await new Promise(resolve => setTimeout(resolve, 0));
            }
        } finally {
            video.pause();
            video.removeAttribute("src");
            video.load();
            URL.revokeObjectURL(url);
        }
    } else {
        const Decoder = (globalThis as typeof globalThis & { ImageDecoder?: ImageDecoderConstructor; }).ImageDecoder;
        const imageType = blob.type === "image/apng" ? "image/png" : blob.type;
        if (Decoder && await Decoder.isTypeSupported(imageType)) {
            const decoder = new Decoder({
                data: await blob.arrayBuffer(),
                type: imageType,
                preferAnimation: true
            });

            try {
                await decoder.tracks.ready;
                const frameCount = decoder.tracks.selectedTrack?.frameCount ?? 1;

                for (let frame = 0; frame < frameCount; frame++) {
                    signal.throwIfAborted();
                    const { image } = await decoder.decode({ frameIndex: frame });
                    try {
                        if (frame === 0) {
                            setDimensions(image.displayWidth, image.displayHeight);
                        }
                        writeFrame(image, (image.duration ?? 100_000) / 1000);
                    } finally {
                        image.close();
                    }
                    onProgress(Math.round((frame + 1) / frameCount * 100));
                    await new Promise(resolve => setTimeout(resolve, 0));
                }
            } finally {
                decoder.close();
            }
        } else {
            if (["image/gif", "image/apng", "image/webp", "image/avif"].includes(blob.type)) {
                throw new Error("This Discord version cannot decode this image's animation. Try importing a WebM instead.");
            }
            const image = await createImageBitmap(blob);
            try {
                setDimensions(image.width, image.height);
                writeFrame(image, 100);
            } finally {
                image.close();
            }
            onProgress(100);
        }
    }

    signal.throwIfAborted();
    gif.finish();
    return new File([gif.bytesView() as Uint8Array<ArrayBuffer>], fileName.replace(/\.[^.]+$/, "") + ".gif", {
        type: "image/gif"
    });
}
