import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";

function Counter() {
  const [n, setN] = useState(0);
  return <button onClick={() => setN(n + 1)}>Count {n}</button>;
}

it("increments", async () => {
  render(<Counter />);
  await userEvent.click(screen.getByRole("button", { name: /count 0/i }));
  expect(screen.getByRole("button").textContent).toBe("Count 1");
});
