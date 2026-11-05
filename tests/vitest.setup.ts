if (!("CSS" in globalThis)) {
  Object.defineProperty(globalThis, "CSS", {
    configurable: true,
    value: { supports: () => false },
  });
}

const elementPrototype = Element.prototype as Element & {
  scrollIntoView?: () => void;
};
if (typeof elementPrototype.scrollIntoView !== "function") {
  elementPrototype.scrollIntoView = () => undefined;
}
