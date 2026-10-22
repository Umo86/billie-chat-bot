"use client";

import { Copy } from "lucide-react";
import { toast } from "sonner";
import { Button, type ButtonProps } from "./button";

/** Copies text; where the browser refuses, selects it so Ctrl+C / ⌘C works. */
export function CopyButton({
  text,
  label = "Copy",
  selectId,
  ...props
}: { text: string; label?: string; selectId?: string } & ButtonProps) {
  return (
    <Button
      size="sm"
      {...props}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          toast.success("Copied.");
        } catch {
          const el = selectId ? document.getElementById(selectId) : null;
          if (el) {
            const range = document.createRange();
            range.selectNodeContents(el);
            const sel = window.getSelection();
            sel?.removeAllRanges();
            sel?.addRange(range);
          }
          toast("Copy is blocked here. The text is selected: press Ctrl+C or ⌘C.");
        }
      }}
    >
      <Copy /> {label}
    </Button>
  );
}
