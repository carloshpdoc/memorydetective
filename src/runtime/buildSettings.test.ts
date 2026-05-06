import { describe, it, expect } from "vitest";
import { parseBuildSettingsJson } from "./buildSettings.js";

describe("parseBuildSettingsJson", () => {
  it("parses a single-target JSON array", () => {
    const stdout = JSON.stringify([
      {
        action: "build",
        target: "MyApp",
        buildSettings: {
          BUILT_PRODUCTS_DIR:
            "/Users/me/Library/Developer/Xcode/DerivedData/MyApp/Build/Products/Debug-iphonesimulator",
          WRAPPER_NAME: "MyApp.app",
          WRAPPER_EXTENSION: "app",
          EXECUTABLE_NAME: "MyApp",
          PRODUCT_BUNDLE_IDENTIFIER: "com.example.MyApp",
        },
      },
    ]);
    const result = parseBuildSettingsJson(stdout);
    expect(result.builtProductsDir).toMatch(/Debug-iphonesimulator$/);
    expect(result.wrapperName).toBe("MyApp.app");
    expect(result.executableName).toBe("MyApp");
    expect(result.productBundleIdentifier).toBe("com.example.MyApp");
  });

  it("disambiguates multi-target by WRAPPER_EXTENSION=app", () => {
    const stdout = JSON.stringify([
      {
        action: "build",
        target: "MyAppFramework",
        buildSettings: {
          BUILT_PRODUCTS_DIR: "/derived/Products/Debug-iphonesimulator",
          WRAPPER_NAME: "MyAppFramework.framework",
          WRAPPER_EXTENSION: "framework",
          EXECUTABLE_NAME: "MyAppFramework",
          PRODUCT_BUNDLE_IDENTIFIER: "com.example.framework",
        },
      },
      {
        action: "build",
        target: "MyApp",
        buildSettings: {
          BUILT_PRODUCTS_DIR: "/derived/Products/Debug-iphonesimulator",
          WRAPPER_NAME: "MyApp.app",
          WRAPPER_EXTENSION: "app",
          EXECUTABLE_NAME: "MyApp",
          PRODUCT_BUNDLE_IDENTIFIER: "com.example.MyApp",
        },
      },
    ]);
    const result = parseBuildSettingsJson(stdout);
    expect(result.wrapperName).toBe("MyApp.app");
    expect(result.productBundleIdentifier).toBe("com.example.MyApp");
  });

  it("tolerates noise before and after the JSON array", () => {
    const json = JSON.stringify([
      {
        target: "MyApp",
        buildSettings: {
          BUILT_PRODUCTS_DIR: "/x",
          WRAPPER_NAME: "MyApp.app",
          WRAPPER_EXTENSION: "app",
          EXECUTABLE_NAME: "MyApp",
          PRODUCT_BUNDLE_IDENTIFIER: "com.example.MyApp",
        },
      },
    ]);
    const stdout = `Resolving package graph...\nFetched packages.\n${json}\nnote: Building targets in dependency order\n`;
    const result = parseBuildSettingsJson(stdout);
    expect(result.executableName).toBe("MyApp");
  });

  it("throws with the missing key name when a required setting is absent", () => {
    const stdout = JSON.stringify([
      {
        target: "MyApp",
        buildSettings: {
          BUILT_PRODUCTS_DIR: "/x",
          WRAPPER_NAME: "MyApp.app",
          WRAPPER_EXTENSION: "app",
          EXECUTABLE_NAME: "MyApp",
          // PRODUCT_BUNDLE_IDENTIFIER omitted on purpose
        },
      },
    ]);
    expect(() => parseBuildSettingsJson(stdout)).toThrow(
      /PRODUCT_BUNDLE_IDENTIFIER/,
    );
  });

  it("throws when no JSON array is present", () => {
    expect(() => parseBuildSettingsJson("warning: nothing here\n")).toThrow(
      /did not contain a JSON array/,
    );
  });

  it("throws when no app target is present", () => {
    const stdout = JSON.stringify([
      {
        target: "MyAppKit",
        buildSettings: {
          BUILT_PRODUCTS_DIR: "/x",
          WRAPPER_NAME: "MyAppKit.framework",
          WRAPPER_EXTENSION: "framework",
          EXECUTABLE_NAME: "MyAppKit",
          PRODUCT_BUNDLE_IDENTIFIER: "com.example.framework",
        },
      },
    ]);
    expect(() => parseBuildSettingsJson(stdout)).toThrow(
      /WRAPPER_EXTENSION=app/,
    );
  });
});
