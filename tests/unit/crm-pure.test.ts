import { describe, expect, it } from "vitest";
import {
  companyDomain,
  filterValue,
  leadNote,
  opportunityName,
  phoneParts,
  splitName,
  twentyBase,
  twentyConfigured,
  twentyHost,
  twentyRecordUrl,
  type Lead,
} from "@/lib/crm/lead-rules";

const lead: Lead = {
  contact: {
    name: "Sam de la Cruz",
    company: "Acme Frames Ltd",
    email: "sam@acmeframes.co.uk",
    phone: "07700 900123",
  },
  answers: [
    { label: "What does your company do or sell?", value: "Timber frames *and* doors" },
    { label: "What size of stand are you thinking of?", value: "About 6x4m" },
  ],
  show: "UKCW London 2027",
  botName: "Visitor Help",
  ref: "R-1042",
  page: "https://www.ukcw.test/exhibit",
  chatUrl: "https://billie.test/inbox?tab=billie&c=abc",
};

describe("Twenty's address and key", () => {
  it("uses Twenty's cloud unless the team has its own", () => {
    expect(twentyBase({})).toBe("https://api.twenty.com");
    expect(twentyBase({ TWENTY_API_URL: " https://crm.media10.test/ " })).toBe(
      "https://crm.media10.test",
    );
    // Pasted with /rest on the end: still the same address.
    expect(twentyBase({ TWENTY_API_URL: "https://crm.media10.test/rest/" })).toBe(
      "https://crm.media10.test",
    );
  });

  it("shows which Twenty is connected, even from a mistyped address", () => {
    expect(twentyHost({})).toBe("api.twenty.com");
    expect(twentyHost({ TWENTY_API_URL: "crm.media10.test" })).toBe("crm.media10.test");
  });

  it("is connected only with a key", () => {
    expect(twentyConfigured({})).toBe(false);
    expect(twentyConfigured({ TWENTY_API_KEY: "  " })).toBe(false);
    expect(twentyConfigured({ TWENTY_API_KEY: "k" })).toBe(true);
  });

  it("links to the record only when the app's address is set", () => {
    expect(twentyRecordUrl("opportunity", "o-1", {})).toBeNull();
    expect(
      twentyRecordUrl("opportunity", "o 1", { TWENTY_APP_URL: "https://media10.twenty.com/" }),
    ).toBe("https://media10.twenty.com/object/opportunity/o%201");
  });
});

describe("a lead's details for Twenty", () => {
  it("splits a name into first and last", () => {
    expect(splitName("Sam de la Cruz")).toEqual({ firstName: "Sam", lastName: "de la Cruz" });
    expect(splitName("  Jo  ")).toEqual({ firstName: "Jo", lastName: "" });
    expect(splitName(undefined)).toEqual({ firstName: "", lastName: "" });
  });

  it("takes the company's web address from a work email, never from free email", () => {
    expect(companyDomain("Sam@AcmeFrames.co.uk")).toBe("https://acmeframes.co.uk");
    expect(companyDomain("jo@gmail.com")).toBeNull();
    expect(companyDomain("jo@btinternet.com")).toBeNull();
    expect(companyDomain("not an email")).toBeNull();
  });

  it("splits UK numbers into their parts, and keeps others as typed", () => {
    const uk = {
      primaryPhoneNumber: "7700900123",
      primaryPhoneCountryCode: "GB",
      primaryPhoneCallingCode: "+44",
    };
    expect(phoneParts("07700 900123")).toEqual(uk);
    expect(phoneParts("+44 (0)7700 900123")).toEqual(uk);
    expect(phoneParts("0044 7700 900123")).toEqual(uk);
    expect(phoneParts("+33 6 12 34 56 78")).toEqual({
      primaryPhoneNumber: "+33612345678",
      primaryPhoneCountryCode: "",
      primaryPhoneCallingCode: "",
    });
    expect(phoneParts("123")).toBeNull();
    expect(phoneParts("")).toBeNull();
  });

  it("keeps quotes out of a filter value", () => {
    expect(filterValue('Acme "Best" Ltd')).toBe('"Acme Best Ltd"');
    expect(filterValue("a\\b")).toBe('"ab"');
  });

  it("names the opportunity after the company and the show", () => {
    expect(opportunityName(lead)).toBe("Acme Frames Ltd – exhibiting at UKCW London 2027");
    expect(opportunityName({ ...lead, contact: { name: "Jo" }, show: "" })).toBe(
      "Jo – exhibiting at the show",
    );
  });

  it("writes a note with what they said and where it came from", () => {
    const note = leadNote(lead);
    expect(note.title).toBe("Exhibiting enquiry from the Visitor Help chat (R-1042)");
    expect(note.markdown).toContain("- **Company**: Acme Frames Ltd");
    // What they typed can't become formatting in Twenty.
    expect(note.markdown).toContain("Timber frames \\*and\\* doors");
    expect(note.markdown).toContain("They were on https://www.ukcw.test/exhibit.");
    expect(note.markdown).toContain(
      "The chat in Billie: https://billie.test/inbox?tab=billie&c=abc",
    );
    expect(note.markdown).not.toMatch(/\n\n\n/);
  });
});
