import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import App from "./App";

describe("App", () => {
  it("renders the dashboard title", () => {
    render(<App />);
    expect(screen.getByText("Claude Usage Dashboard")).toBeInTheDocument();
  });
});
