import * as React from 'react'
import { createPortal } from 'react-dom'
import { createSponsorUI } from '../../../src/sponsor.js'
import image from '../../../docs/images/sponsor-beichen-examples.jpg?inline'
import '../../../src/sponsor.css'

export const { SponsorPage, SponsorNotice } = createSponsorUI(React, image, createPortal, 'desktop')
