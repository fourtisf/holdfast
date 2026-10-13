"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/components/ui/cn";
import { CloseIcon, UploadIcon } from "@/components/ui/icons";
import { api, errorMessage } from "@/lib/api";
import { IMAGE_MAX_BYTES, IMAGE_TYPES } from "@/lib/launch";

/** Picks an image, shows it immediately and uploads it via POST /uploads/image. */
export function ImageDrop({
  onUploaded,
  onUploadingChange,
}: {
  onUploaded: (url: string | null, preview: string | null) => void;
  onUploadingChange: (uploading: boolean) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [status, setStatus] = useState<"idle" | "uploading" | "done" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const fileRef = useRef<File | null>(null);

  useEffect(
    () => () => {
      if (preview) URL.revokeObjectURL(preview);
    },
    [preview],
  );

  const upload = async (file: File, previewUrl: string) => {
    fileRef.current = file;
    setStatus("uploading");
    setError(null);
    onUploadingChange(true);
    try {
      const { imageUrl } = await api.uploadImage(file);
      if (fileRef.current !== file) return;
      setStatus("done");
      onUploaded(imageUrl, previewUrl);
    } catch (err) {
      if (fileRef.current !== file) return;
      setStatus("error");
      setError(errorMessage(err));
      onUploaded(null, null);
    } finally {
      if (fileRef.current === file) onUploadingChange(false);
    }
  };

  const pick = (file: File | undefined) => {
    if (!file) return;
    if (!IMAGE_TYPES.includes(file.type)) {
      setError("Use a PNG, JPG, GIF or WebP image");
      setStatus("error");
      return;
    }
    if (file.size > IMAGE_MAX_BYTES) {
      setError("Image must be 5 MB or smaller");
      setStatus("error");
      return;
    }
    const url = URL.createObjectURL(file);
    setPreview(url);
    void upload(file, url);
  };

  const clear = () => {
    fileRef.current = null;
    setPreview(null);
    setStatus("idle");
    setError(null);
    onUploaded(null, null);
    onUploadingChange(false);
    if (input.current) input.current.value = "";
  };

  return (
    <div>
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          pick(e.dataTransfer.files[0]);
        }}
        className={cn(
          "relative flex items-center gap-4 rounded-card border border-dashed p-3 transition-colors",
          dragging ? "border-brand bg-brand/5" : status === "error" ? "border-sell/50" : "border-line-strong bg-surface-2/50",
        )}
      >
        <button
          type="button"
          onClick={() => input.current?.click()}
          className="relative flex size-20 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-surface-3 text-muted ring-1 ring-line hover:text-fg"
          aria-label={preview ? "Replace image" : "Upload image"}
        >
          {preview ? (
            // eslint-disable-next-line @next/next/no-img-element -- local object URL preview
            <img src={preview} alt="Coin image preview" className="size-full object-cover" />
          ) : (
            <UploadIcon size={22} />
          )}
          {status === "uploading" ? (
            <span className="absolute inset-0 flex items-center justify-center bg-bg/60 text-[10px] font-semibold text-fg">Uploading…</span>
          ) : null}
        </button>
        <div className="min-w-0 flex-1 text-sm">
          <div className="font-semibold text-fg">
            {preview ? (status === "done" ? "Image uploaded" : status === "uploading" ? "Uploading image…" : "Image") : "Coin image"}
          </div>
          <div className="text-xs text-muted">PNG, JPG, GIF or WebP · up to 5 MB · square works best.</div>
          <div className="mt-1.5 flex gap-3 text-xs">
            <button type="button" onClick={() => input.current?.click()} className="font-semibold text-brand hover:underline">
              {preview ? "Replace" : "Choose file"}
            </button>
            {status === "error" && fileRef.current ? (
              <button
                type="button"
                onClick={() => fileRef.current && preview && void upload(fileRef.current, preview)}
                className="font-semibold text-fg hover:underline"
              >
                Retry
              </button>
            ) : null}
          </div>
        </div>
        {preview ? (
          <button
            type="button"
            onClick={clear}
            className="absolute top-2 right-2 rounded-md p-1 text-faint hover:bg-surface-3 hover:text-fg"
            aria-label="Remove image"
          >
            <CloseIcon size={14} />
          </button>
        ) : null}
        <input
          ref={input}
          type="file"
          accept={IMAGE_TYPES.join(",")}
          className="sr-only"
          onChange={(e) => pick(e.target.files?.[0])}
          tabIndex={-1}
          aria-hidden
        />
      </div>
      {error ? (
        <p className="mt-1.5 text-xs text-sell">{error}</p>
      ) : (
        <p className="mt-1.5 text-xs text-faint">No image? Your coin gets a unique mascot instead.</p>
      )}
    </div>
  );
}
