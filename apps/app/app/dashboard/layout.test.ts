import { expect, test } from "vitest";

import DashboardLayout from "./layout";

test("renders children without reading request cookies in the layout", () => {
	expect(DashboardLayout({ children: "ok" })).toBeTruthy();
});
