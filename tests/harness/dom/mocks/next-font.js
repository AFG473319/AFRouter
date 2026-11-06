const font = () => ({ className: "", style: {}, variable: "" });
export default new Proxy({}, { get: () => font });
export const Inter = font;
export const Geist = font;
export const Geist_Mono = font;
export const Vazirmatn = font;
