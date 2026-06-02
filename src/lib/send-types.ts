// Shared enums/types for the Send flow. Declared once so App.tsx,
// ReadyScreen.tsx and SendPanel.tsx all reference the same union.

export type SendStep = 'input' | 'amount' | 'confirm' | 'sending' | 'success' | 'error';
