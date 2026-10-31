import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * Funcao de deteccao de erro de billing / cota extraida de model-queue.ts
 *
 * O que este teste executa:
 * Valida que respostas com o shape da Issue #721 (contendo pricingUrl ou 112/model_error)
 * sao corretamente identificadas como billing/quota error, disparando a rotacao de conta,
 * enquanto erros genericos de servidor continuam nao correspondendo.
 */
function looksLikeBillingError(text) {
  return /billing\s+daily\s+count\s+exceeded|daily\s+count\s+exceeded|billing_error|\bpricingUrl\b|\b112\/model_error\b/i.test(text);
}

test('Issue #721: Resposta com pricingUrl e (112/model_error) deve ser reconhecida como billing error para rotacao de conta', () => {
  // O que este teste executa:
  // Valida o payload real reportado pelo usuario na issue 721:
  // qoder: {"pricingUrl":"https://qoder.com.cn/pricing?client=qoder"} (112/model_error)
  const errorText = 'qoder: {"pricingUrl":"https://qoder.com.cn/pricing?client=qoder"} (112/model_error)';
  assert.equal(looksLikeBillingError(errorText), true);
});

test('Issue #721: Erros padrao de billing continuam sendo reconhecidos', () => {
  // O que este teste executa:
  // Garante compatibilidade retroativa com mensagens classicas como 'billing daily count exceeded'
  assert.equal(looksLikeBillingError('Billing daily count exceeded'), true);
  assert.equal(looksLikeBillingError('daily count exceeded'), true);
  assert.equal(looksLikeBillingError('billing_error'), true);
});

test('Issue #721: Textos normais e erros genericos de servidor nao disparam falso positivo', () => {
  // O que este teste executa:
  // Garante que erros comuns de rede ou 500 sem padrao de cota nao sejam confundidos com billing error
  assert.equal(looksLikeBillingError('Internal Server Error 500'), false);
  assert.equal(looksLikeBillingError('Gateway timeout'), false);
  assert.equal(looksLikeBillingError('The user requested their balance'), false);
});
