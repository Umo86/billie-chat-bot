import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { users } from "@/lib/db/schema";
import {
  acceptInvitation,
  createInvitation,
  invitationForToken,
  linkFirstAdmin,
  setSuspended,
  signUpAllowed,
} from "@/lib/team/accounts";
import { hasDb, makeUser } from "../helpers/db";

const authUser = (email: string) => ({ id: randomUUID(), email, name: "New Person" });
const tokenOf = (link: string) => link.split("/invite/")[1];

describe.skipIf(!hasDb)("team accounts linked to Neon Auth", () => {
  it("lets an invited person join with the invited role", async () => {
    const admin = await makeUser("admin");
    const email = `${randomUUID().slice(0, 8)}@media10.test`;
    const { link } = await createInvitation(admin, { email, name: "Priya Shah", role: "agent" });
    const token = tokenOf(link);
    expect(await signUpAllowed(email)).toBe(true);
    expect(await invitationForToken(token)).not.toBeNull();

    const who = authUser(email);
    const started = new Date();
    const id = await acceptInvitation(token, who, started);
    const row = await db.query.users.findFirst({ where: eq(users.id, id) });
    expect(row).toMatchObject({ authUserId: who.id, email, role: "agent", fullName: "Priya Shah" });
    expect(row?.linkedAt?.getTime()).toBe(started.getTime());

    // The link works once, and the email no longer has an open invitation.
    await expect(acceptInvitation(token, who, new Date())).rejects.toThrow(/expired|used/);
    expect(await signUpAllowed(email)).toBe(false);
  });

  it("refuses a link used with a different email", async () => {
    const admin = await makeUser("admin");
    const email = `${randomUUID().slice(0, 8)}@media10.test`;
    const { link } = await createInvitation(admin, { email, name: "A", role: "editor" });
    await expect(
      acceptInvitation(tokenOf(link), authUser("someone@else.test"), new Date()),
    ).rejects.toThrow(/different email/);
  });

  it("re-links an existing member to a new sign-in and keeps their role", async () => {
    const admin = await makeUser("admin");
    const member = await makeUser("editor");
    const { link } = await createInvitation(admin, {
      email: member.email,
      name: "",
      role: "agent",
    });
    const who = authUser(member.email);
    const id = await acceptInvitation(tokenOf(link), who, new Date());
    expect(id).toBe(member.id);
    const row = await db.query.users.findFirst({ where: eq(users.id, member.id) });
    expect(row).toMatchObject({ authUserId: who.id, role: "editor" });
  });

  it("won't link a suspended member", async () => {
    const admin = await makeUser("admin");
    const member = await makeUser("agent");
    await setSuspended(admin, member.id, true);
    const { link } = await createInvitation(admin, {
      email: member.email,
      name: "",
      role: "agent",
    });
    await expect(
      acceptInvitation(tokenOf(link), authUser(member.email), new Date()),
    ).rejects.toThrow(/suspended/);
  });

  it("allows no uninvited sign-ups once the team exists, and no second first admin", async () => {
    await makeUser("admin");
    expect(await signUpAllowed(`${randomUUID().slice(0, 8)}@random.test`)).toBe(false);
    await expect(
      linkFirstAdmin(authUser("first@media10.test"), "First", new Date()),
    ).rejects.toThrow(/already set up/);
  });
});
