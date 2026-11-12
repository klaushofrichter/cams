import './styles/theme.css';
import { mount } from 'svelte';
import Landing from './Landing.svelte';
import SignIn from './SignIn.svelte';
import Token from './Token.svelte';

// No noPinch() here: the public pages zoom (WCAG 1.4.4, web/index.html).

// One bundle for the start page (/), the sign-in page (/signin) and the
// viewer token sign-in (/token).
const page = location.pathname === '/signin' ? SignIn : location.pathname === '/token' ? Token : Landing;
mount(page, { target: document.getElementById('root')! });
