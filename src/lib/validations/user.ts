import { z } from "zod";

export const updateProfileSchema = z.object({
  name: z
    .string({ required_error: "Name is required" })
    .trim()
    .min(2, "Name must be at least 2 characters")
    .max(100, "Name must be 100 characters or fewer"),
  email: z
    .string({ required_error: "Email is required" })
    .trim()
    .email("Please provide a valid email address")
    .max(255, "Email must be 255 characters or fewer"),
});

export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;
