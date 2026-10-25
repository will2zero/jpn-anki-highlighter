export default {
  join(...parts) {
    return parts
      .filter(Boolean)
      .map((part) => String(part).replace(/^\/+|\/+$/g, ""))
      .filter(Boolean)
      .join("/");
  }
};
