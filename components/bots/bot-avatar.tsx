import { initials, textOn } from "@/lib/bots/slug";
import { cn } from "@/lib/utils";

/** A bot's face: its uploaded picture, or initials on its colour. */
export function BotAvatar({
  name,
  color,
  avatarUrl,
  size = 44,
  className,
}: {
  name: string;
  color: string;
  avatarUrl: string | null;
  size?: number;
  className?: string;
}) {
  const style = {
    width: size,
    height: size,
    background: color,
    color: textOn(color),
    fontSize: size * 0.36,
  };
  return avatarUrl ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={avatarUrl}
      alt=""
      width={size}
      height={size}
      className={cn("shrink-0 rounded-full object-cover", className)}
      style={{ width: size, height: size }}
    />
  ) : (
    <span
      aria-hidden
      className={cn("grid shrink-0 place-items-center rounded-full font-extrabold", className)}
      style={style}
    >
      {initials(name || "Bot")}
    </span>
  );
}
