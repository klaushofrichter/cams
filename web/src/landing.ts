import './styles/theme.css';
import { mount } from 'svelte';
import Landing from './Landing.svelte';
import SignIn from './SignIn.svelte';

// One bundle for the start page (/) and the sign-in page (/signin).
const page = location.pathname === '/signin' ? SignIn : Landing;
mount(page, { target: document.getElementById('root')! });
