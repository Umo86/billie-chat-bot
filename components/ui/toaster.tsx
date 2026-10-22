"use client";

import { Toaster as Sonner } from "sonner";

/** Toasts for success and undo; at most three at a time, short-lived, bottom centre. */
export function Toaster() {
  return (
    <Sonner
      position="bottom-center"
      visibleToasts={3}
      duration={3500}
      toastOptions={{
        classNames: {
          toast: "!bg-foreground !text-card !border-0 !rounded-[10px] !font-semibold",
          actionButton: "!bg-card !text-foreground !font-bold",
        },
      }}
    />
  );
}
