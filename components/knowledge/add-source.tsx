"use client";

import { useRef, useState } from "react";
import { toast } from "sonner";
import { FileUp, Globe, MessageSquareText, Type } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, Input, Textarea } from "@/components/ui/form";
import { Segmented } from "@/components/ui/segmented";
import { Switch } from "@/components/ui/switch";
import { Panel } from "@/components/ui/bits";
import { useRunner } from "@/components/ui/use-runner";
import {
  addQaAction,
  addTextAction,
  addWebAction,
  registerUploadAction,
  uploadFileAction,
} from "@/app/actions/knowledge";

type Tab = "file" | "text" | "qa" | "web";

/** Under this size a file goes through the server action; above it, straight to Blob. */
const DIRECT_LIMIT = 4 * 1024 * 1024;

export function AddSource({
  kbId,
  accept,
  maxBytes,
  blobUploads,
}: {
  kbId: string;
  accept: string[];
  maxBytes: number;
  blobUploads: boolean;
}) {
  const [tab, setTab] = useState<Tab>("file");
  return (
    <Panel className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-[1.05rem]">Add knowledge</h2>
        <Segmented<Tab>
          label="What to add"
          value={tab}
          onChange={setTab}
          options={[
            {
              value: "file",
              label: (
                <span className="inline-flex items-center gap-1.5">
                  <FileUp className="size-4" aria-hidden /> Files
                </span>
              ),
            },
            {
              value: "text",
              label: (
                <span className="inline-flex items-center gap-1.5">
                  <Type className="size-4" aria-hidden /> Paste text
                </span>
              ),
            },
            {
              value: "qa",
              label: (
                <span className="inline-flex items-center gap-1.5">
                  <MessageSquareText className="size-4" aria-hidden /> Typed answer
                </span>
              ),
            },
            {
              value: "web",
              label: (
                <span className="inline-flex items-center gap-1.5">
                  <Globe className="size-4" aria-hidden /> Web page
                </span>
              ),
            },
          ]}
        />
      </div>
      {tab === "file" ? (
        <FileDrop kbId={kbId} accept={accept} maxBytes={maxBytes} blobUploads={blobUploads} />
      ) : tab === "text" ? (
        <PasteText kbId={kbId} />
      ) : tab === "qa" ? (
        <TypedAnswer kbId={kbId} />
      ) : (
        <WebPage kbId={kbId} />
      )}
    </Panel>
  );
}

function FileDrop({
  kbId,
  accept,
  maxBytes,
  blobUploads,
}: {
  kbId: string;
  accept: string[];
  maxBytes: number;
  blobUploads: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState<{ name: string; pct: number } | null>(null);
  const limit = blobUploads ? maxBytes : DIRECT_LIMIT;

  async function uploadOne(file: File): Promise<boolean> {
    const ext = "." + (file.name.split(".").pop() ?? "").toLowerCase();
    if (!accept.includes(ext)) {
      toast.error(
        `${file.name}: Billie reads PDF, Word (.docx), Excel (.xlsx), CSV and text files.`,
      );
      return false;
    }
    if (file.size > limit) {
      toast.error(
        `${file.name} is over ${Math.round(limit / 1024 / 1024)} MB. Split it or paste the text instead.`,
      );
      return false;
    }
    setBusy({ name: file.name, pct: 0 });
    try {
      if (blobUploads && file.size > DIRECT_LIMIT) {
        const { upload } = await import("@vercel/blob/client");
        const safe = file.name
          .normalize("NFKD")
          .replace(/[^\w.-]+/g, "-")
          .slice(-120);
        const blob = await upload(`sources/${safe}`, file, {
          access: "private",
          handleUploadUrl: "/api/blob/upload",
          multipart: file.size > 8 * 1024 * 1024,
          contentType: file.type || undefined,
          onUploadProgress: (p) => setBusy({ name: file.name, pct: Math.round(p.percentage) }),
        });
        const r = await registerUploadAction({
          kbId,
          pathname: blob.pathname,
          name: file.name,
          size: file.size,
          type: file.type,
        });
        if (!r.ok) {
          toast.error(r.error);
          return false;
        }
      } else {
        const form = new FormData();
        form.set("kbId", kbId);
        form.set("file", file);
        const r = await uploadFileAction(form);
        if (!r.ok) {
          toast.error(r.error);
          return false;
        }
      }
      return true;
    } catch (err) {
      console.error(err);
      toast.error(`${file.name} couldn't be uploaded. Try again.`);
      return false;
    } finally {
      setBusy(null);
    }
  }

  async function take(files: FileList | File[]) {
    const list = Array.from(files);
    let added = 0;
    for (const f of list) if (await uploadOne(f)) added += 1;
    if (added)
      toast.success(
        added === 1
          ? "Added. Billie is reading it."
          : `${added} files added. Billie is reading them.`,
      );
    if (input.current) input.current.value = "";
  }

  return (
    <div className="flex flex-col gap-2">
      <label
        htmlFor="file-input"
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          if (!busy) void take(e.dataTransfer.files);
        }}
        className={`flex min-h-36 cursor-pointer flex-col items-center justify-center gap-2 rounded-[12px] border-2 border-dashed px-4 py-6 text-center ${
          over ? "border-primary bg-accent" : "border-border hover:border-primary/50"
        }`}
      >
        <FileUp className="size-7 text-primary" aria-hidden />
        {busy ? (
          <span className="font-semibold" role="status">
            Uploading {busy.name}
            {busy.pct ? ` (${busy.pct}%)` : "…"}
          </span>
        ) : (
          <>
            <span className="font-semibold">Drop files here, or click to choose</span>
            <span className="text-sm text-muted-foreground">
              PDF, Word (.docx), Excel (.xlsx), CSV or text, up to {Math.round(limit / 1024 / 1024)}{" "}
              MB each. The exhibitor manual is the best place to start.
            </span>
          </>
        )}
      </label>
      <input
        ref={input}
        id="file-input"
        type="file"
        multiple
        accept={accept.join(",")}
        className="sr-only"
        disabled={!!busy}
        onChange={(e) => e.target.files && void take(e.target.files)}
      />
    </div>
  );
}

function PasteText({ kbId }: { kbId: string }) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const { pending, run } = useRunner();
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        run(() => addTextAction({ kbId, title, body }), {
          done: () => {
            setTitle("");
            setBody("");
          },
        });
      }}
    >
      <Field
        id="text-title"
        label="Title"
        hint="So you can find it later, e.g. Parking and transport"
      >
        <Input
          id="text-title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          maxLength={200}
        />
      </Field>
      <Field id="text-body" label="Text">
        <Textarea
          id="text-body"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          className="min-h-44"
          placeholder="Paste from an email, a web page or a document."
          required
        />
      </Field>
      <div>
        <Button type="submit" variant="primary" disabled={pending || !body.trim()}>
          Add text
        </Button>
      </div>
    </form>
  );
}

function TypedAnswer({ kbId }: { kbId: string }) {
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState("");
  const { pending, run } = useRunner();
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        run(() => addQaAction({ kbId, question, answer }), {
          done: () => {
            setQuestion("");
            setAnswer("");
          },
        });
      }}
    >
      <p className="text-sm text-muted-foreground">
        For things that aren&apos;t written down anywhere, or that the bot keeps getting wrong.
        Typed answers are used ahead of documents.
      </p>
      <Field id="qa-q" label="Question">
        <Input
          id="qa-q"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="Can we bring our own forklift?"
          maxLength={300}
          required
        />
      </Field>
      <Field id="qa-a" label="Answer">
        <Textarea
          id="qa-a"
          value={answer}
          onChange={(e) => setAnswer(e.target.value)}
          maxLength={4000}
          required
        />
      </Field>
      <div>
        <Button
          type="submit"
          variant="primary"
          disabled={pending || !question.trim() || !answer.trim()}
        >
          Save answer
        </Button>
      </div>
    </form>
  );
}

function WebPage({ kbId }: { kbId: string }) {
  const [url, setUrl] = useState("");
  const [weekly, setWeekly] = useState(true);
  const { pending, run } = useRunner();
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        run(() => addWebAction({ kbId, url, refreshWeekly: weekly }), {
          done: () => setUrl(""),
        });
      }}
    >
      <Field
        id="web-url"
        label="Page address"
        hint="A public page, such as the show's FAQ or travel page. Billie reads that one page, not the whole site."
      >
        <Input
          id="web-url"
          type="url"
          inputMode="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://www.example-show.co.uk/visit/travel"
          required
        />
      </Field>
      <label className="flex items-center gap-3">
        <Switch
          checked={weekly}
          onCheckedChange={setWeekly}
          aria-label="Read it again every week"
        />
        <span>Read it again every week, so changes to the page are picked up</span>
      </label>
      <div>
        <Button type="submit" variant="primary" disabled={pending || !url.trim()}>
          Add page
        </Button>
      </div>
    </form>
  );
}
