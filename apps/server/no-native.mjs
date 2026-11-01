/**
 * Optional native add-ons (ssh2's crypto, cpu-features) are not bundled: each require of a .node file throws, as when the
 * add-on was never built, and the package falls back to Node's own crypto.
 */
export const noNative = {
  name: "no-native",
  setup(build) {
    build.onResolve({ filter: /\.node$/ }, (args) => ({ path: args.path, namespace: "no-native" }));
    build.onLoad({ filter: /.*/, namespace: "no-native" }, () => ({ contents: 'throw new Error("This native add-on is not bundled");', loader: "js" }));
  },
};
