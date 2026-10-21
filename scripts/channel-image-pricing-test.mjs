import assert from 'node:assert/strict'
import { LlmAdapter } from './lib/channel-pack-kernel.mjs'

/** 实际发布渠道包在缺失、继承默认和已有厂商计价时的行为。 */
export function verifyChannelImagePricing(adapters) {
  const images = [{ type: 'image', attachment: {} }, { type: 'image', attachment: {}, offloaded: true }]
  for (const [provider, adapter] of adapters) {
    const pricing = adapter.imageRequestPricing(provider, 'deepseek-v4.1-flash')
    assert.equal(typeof pricing?.priceImages, 'function', `${provider} 必须同步提供计价器`)
    assert.equal(typeof pricing.then, 'undefined')
    assert.deepEqual(pricing.priceImages(images), [
      { visualTokens: 1024, text: '[image]' }, { visualTokens: 0, text: '[image omitted]' },
    ])
    assert.deepEqual(pricing.priceImages([]), [])
    const repeated = pricing.priceImages([images[0], images[0]])
    assert.equal(repeated.length, 2, '相同图片的多个出现位置必须分别计价')
    repeated[0].visualTokens = 1
    assert.equal(pricing.priceImages([images[0]])[0].visualTokens, 1024, '调用方修改结果不能污染后续预算')
  }
  const original = Object.getOwnPropertyDescriptor(LlmAdapter.prototype, 'imageRequestPricing')
  try {
    LlmAdapter.prototype.imageRequestPricing = () => undefined
    assert.equal(adapters.get('buddy').imageRequestPricing('buddy', 'model').priceImages(images).length, 2,
      '宿主默认方法返回 undefined 时也必须兜底')
    const native = { priceImages: () => [{ visualTokens: 2345, text: 'native' }] }
    LlmAdapter.prototype.imageRequestPricing = function (provider, model) {
      assert.equal(provider, 'buddy'); assert.equal(model, 'native-model')
      assert.ok(this instanceof LlmAdapter)
      assert.notEqual(this, adapters.get('buddy'), '厂商方法必须绑定原对象')
      return native
    }
    assert.equal(adapters.get('buddy').imageRequestPricing('buddy', 'native-model'), native,
      '已有厂商计价器必须原样保留')
    LlmAdapter.prototype.imageRequestPricing = () => { throw new Error('native-pricing-error') }
    assert.throws(() => adapters.get('buddy').imageRequestPricing('buddy', 'model'), /native-pricing-error/,
      '厂商实现的真实异常不能被吞掉')
  } finally {
    if (original) Object.defineProperty(LlmAdapter.prototype, 'imageRequestPricing', original)
    else delete LlmAdapter.prototype.imageRequestPricing
  }
}
