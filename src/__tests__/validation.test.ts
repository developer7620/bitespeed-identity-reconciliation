import { parseIdentifyRequest } from "../validation/identifySchema";

describe("parseIdentifyRequest", () => {
  it("accepts valid email only", () => {
    const result = parseIdentifyRequest({ email: "test@example.com" });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.email).toBe("test@example.com");
  });

  it("accepts valid phoneNumber only", () => {
    const result = parseIdentifyRequest({ phoneNumber: "9876543210" });
    expect(result.success).toBe(true);
  });

  it("accepts numeric phoneNumber and coerces to string", () => {
    const result = parseIdentifyRequest({ phoneNumber: 9876543210 });
    expect(result.success).toBe(true);
    if (result.success) expect(typeof result.data.phoneNumber).toBe("string");
  });

  it("accepts both email and phoneNumber", () => {
    const result = parseIdentifyRequest({
      email: "a@b.com",
      phoneNumber: "1234567890",
    });
    expect(result.success).toBe(true);
  });

  it("rejects when both fields are missing", () => {
    const result = parseIdentifyRequest({});
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errors.some((e) => e.message.includes("At least one"))).toBe(true);
    }
  });

  it("rejects when both fields are null", () => {
    const result = parseIdentifyRequest({ email: null, phoneNumber: null });
    expect(result.success).toBe(false);
  });

  it("rejects invalid email format", () => {
    const result = parseIdentifyRequest({ email: "not-an-email" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errors.some((e) => e.message.toLowerCase().includes("email"))).toBe(true);
    }
  });

  it("rejects invalid phone (too short)", () => {
    const result = parseIdentifyRequest({ phoneNumber: "123" });
    expect(result.success).toBe(false);
  });

  it("trims whitespace from email", () => {
    const result = parseIdentifyRequest({ email: "  hello@world.com  " });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.email).toBe("hello@world.com");
  });

  it("returns null for omitted fields in output", () => {
    const result = parseIdentifyRequest({ email: "x@y.com" });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.phoneNumber).toBeNull();
  });
});
