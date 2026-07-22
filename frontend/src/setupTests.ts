import "@testing-library/jest-dom";

// Mock ResizeObserver for recharts testing
global.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
};
