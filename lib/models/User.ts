import { Schema, model, models } from "mongoose";

const UserSchema = new Schema(
  {
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      maxlength: 320,
    },
    passwordHash: { type: String, required: true },
    name: { type: String, default: "", trim: true, maxlength: 120 },
  },
  { timestamps: true },
);

export const User = models.User ?? model("User", UserSchema);
